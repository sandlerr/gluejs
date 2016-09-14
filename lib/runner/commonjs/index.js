var fs = require('fs'),
    path = require('path'),
    util = require('util'),
    runner = require('minitask').runner,
    Task = require('minitask').Task,
    Cache = require('minitask').Cache,
    // tasks
    annotateStat = require('../../list-tasks/annotate-stat.js'),
    inferPackages = require('../../list-tasks/infer-packages.js'),
    filterNpm = require('../../list-tasks/filter-npm.js'),
    filterRegex = require('../../list-tasks/filter-regex.js'),
    filterPackages = require('../../list-tasks/filter-packages.js'),
    getFileTasks = require('./get-file-tasks.js'),
    getCommands = require('./get-commands.js'),
    reqWrap = require('../../require/index.js'),

    log = require('minilog')('commonjs'),
    ProgressBar = require('progress');

// this runner concatenates the files to stdout after running wrap-commonjs-web
module.exports = function(list, options, out, onDone) {
  if(!options) {
    options = {};
  }
  // unpack options
  var packageRootFileName,
      // normalize basepath
      basepath = (options.basepath ? path.normalize(options.basepath) : ''),
      // replaced modules (e.g. jquery => window.jquery)
      replaced = Object.keys(options.replaced || {}).map(function(key) {
        return JSON.stringify(key) + ': '+ '{ exports: ' + options.replaced[key] + ' }';
      }).join(',\n'),
      // remapped modules (e.g. assert => require('chai').assert
      remapped = Object.keys(options.remap || {}).map(function(key) {
        return JSON.stringify(key) + ': '+
        'function(module, exports, require) { module.exports = ' + options.remap[key] + ' }';
      }).join(',\n'),
      // commands
      commands = getCommands(options),
      // cache hit filepaths for reporting
      cacheHits = [],
      optsHash = Cache.hash(JSON.stringify(options)),
      progress;

  // console.log(util.inspect(list.files.map(function(i) { return i.name; }), false, 20, true));

  // exclude files using the npmjs defaults for file and path exclusions
  filterNpm(list);
  // exclude files matching specific expressions
  // - because .npmignores often do not cover all the files to exclude
  var excludeList = [
    new RegExp('\/dist\/'),
    new RegExp('\/example\/'),
    new RegExp('\/benchmark\/'),
    new RegExp('[-.]min.js$')
  ];

  // allow --reset-exclude
  if(options['reset-exclude']) {
    excludeList = [];
  }

  // allow adding in expressions
  if(options['exclude']) {
    excludeList = excludeList.concat(
      (Array.isArray(options['exclude']) ? options['exclude'] : [ options['exclude'] ])
      .map(function(expr) {
        return new RegExp(expr);
      })
    );
  }

  filterRegex(list, excludeList);

  annotateStat(list);

  // run list level tasks

  // - generate `.packages` from `.files`
  // (by grouping the set of `.files` into distinct dependencies)
  //   ... and infer the package main file
  inferPackages(list, { main: options.main, basepath: basepath });
  // - for each package, apply excludes (package.json.files, .npmignore, .gitignore)
  filterPackages(list);

  // console.log(util.inspect(list, false, 20, true));

  // if the main package is empty, use the next one
  // TODO FIXME: this occurs when you are in a ./node_modules/ directory and run
  // a regular build via the command line. Suddenly, the folder you are in is detected as a
  // separate package! Need a better test for this in the long run...
  if(list.packages[0].files.length === 0) {
    list.packages.shift();
  }
  if(list.packages.length === 0) {
    throw new Error('No files were included in the build. Check your `.include()` call paths.');
  }

  // pluck the main file for the first package
  packageRootFileName = list.packages[0].main || options.main;

  if(typeof packageRootFileName === 'undefined') {
    throw new Error('You need to set the package root file explicitly, ' +
      'e.g.: `.main(\'index.js\')` or `--main index.js`. This is the file that\'s exported ' +
      'as the root of the package.');
  }

  // filter out non-JS files (more accurately, files that have no tasks that match them)
  var removed = [];
  // find the ignore files (applying them in the correct order)

  delete list.structured;

  // produce the file
  var packageTasks = [],
      wrapOpts = {
        'export': options['export'] || 'App',
        'root-file': packageRootFileName,
        // `--amd` and `--umd` are synonyms (since umd provides a superset of the amd features)
        type: (options['amd'] || options['umd'] ? 'umd' : (options['node'] ? 'node' : 'global')),
        // options: global-require: export the require() implementation into the global space
        'global-require': options['global-require'] || false,
        require: (options.require !== false ? 'min' : 'max')
      };

  packageTasks.push(function(out, done) {
    // top level boundary + require() implementation
    out.write(reqWrap.prelude(wrapOpts));
    // the registry definition
    out.write('r.m = [];\n');
    done();
  });

  // for each module, write `r.m[n] = { normalizedName: .. code .. , };`

  list.packages.forEach(function(packageObj, current) {

    // package header
    packageTasks.push(function header(out, done) {
      // out.write('/* -- ' + (packageObj.name ? packageObj.name : 'root') + ' -- */\n');
      log.info('Processing package:', (packageObj.name ? packageObj.name : 'root'));
      out.write('r.m['+current+'] = {\n');
      // store replaced and remapped for all packages
      if(replaced) {
        out.write(replaced + ',\n');
      }
      if(remapped) {
        out.write(remapped + ',\n');
      }

      // store dependency references
      Object.keys(packageObj.dependenciesById).forEach(function(name) {
        var uid = packageObj.dependenciesById[name],
            index;

        // find the package in the (possibly altered) packages list by unique id
        list.packages.some(function(item, itemIndex) {
          var match = (item.uid == uid);
          if(match) {
            index = itemIndex;
          }
          return match;
        });

        // r.m[n]['foo'] = { c: 1, m: 'lib/index.js' }
        out.write(
          JSON.stringify(name) + ': ' + JSON.stringify({
            c: index,
            m: list.packages[index].main
          }));
        out.write(',\n');
      });

      done();
    });

    // filter files (and generate tasks)
    packageObj.files = packageObj.files.filter(function(item) {
      if(!fs.existsSync(item.name)) {
        throw new Error('File not found: ' + item.name + ' Basepath = "' +
          packageObj.basepath + '", filename="' + item.name + '"');
      }

      item.tasks = getFileTasks(item, packageObj, commands);
      if(item.tasks.length === 0) {
        log.info('Excluded non-js/non-json file:', path.relative(packageObj.basepath, item.name));
        // also update list.files
        removed.push(item.name);
        return false; // exclude from package.files
      }
      return true; // do not filter out this file
    });

    // stream each file in serial order
    var totalFiles = packageObj.files.length;
    packageObj.files.forEach(function(item, index) {
      var exportVariableName = options['export'] || 'App',
          filePath = item.name,
          relativeName = path.relative(packageObj.basepath, filePath),
          moduleName = relativeName;

      // check for renames via options._rename
      if(options._rename[filePath]) {
        moduleName = path.relative(packageObj.basepath, options._rename[filePath]);
      }

      // all dependencies already have a basepath and the names are
      // already relative to it, but this is not true for the main package
      if(current === 0 && moduleName.substr(0, basepath.length) == basepath) {
        moduleName = moduleName.substr(basepath.length);
      }

      // add the first task
      packageTasks.push(
        function(out, done) {
          out.write(JSON.stringify(moduleName) + ': ');
          done();
        });

      // wrap in a function to reduce file handle usage
      var task = new Task(item.tasks).input(function() { return fs.createReadStream(filePath); } );

      // these are used to disambiguate cached results
      task.inputFilePath = filePath;
      task.taskHash = optsHash;

      task.once('hit', function() {
        cacheHits.push(filePath);
        if(options.progress) {
          progress.tick();
        }
      });

      task.once('miss', function() {
        if(options.progress) {
          progress.tick();
        } else {
          log.info('  Processing file', filePath);
        }
      });

      packageTasks.push(task);

      packageTasks.push(
        function(out, done) {
          // determining when to write the last common becomes easy
          // when files are processed last
          if(index == totalFiles - 1) {
            out.write('\n');
          } else {
            out.write(',\n');
          }
          done();
        });
    });

    // package footer
    packageTasks.push(function(out, done) {
      out.write('};\n');
      done();
    });
  });

  if (options['postlude']) {
    packageTasks.push(function(out, done) {
      out.write(fs.readFileSync(options['postlude']));
      out.write('\n');
      done();
    });
  }

  packageTasks.push(function(out, done) {
    // finally, close the package file
    out.write(reqWrap.postlude(wrapOpts));

    delete list.structured;

    // tj's progress can make the process hang (!) if the total count is off due to exclusions
    if(progress && progress.rl && progress.rl.close) {
      progress.rl.close();
    }

    // if any reporting is explicitly enabled
    if(options.report || options.verbose || options.progress) {
      if(cacheHits.length > 0) {
        console.log('Cache hits (' + options['cache-path'] + '):',
          cacheHits.length, '/', list.files.length, 'files');
        // exclude cached files
        list.packages.forEach(function(pack, index) {
          list.packages[index].files = list.packages[index].files.filter(function(item) {
            return cacheHits.indexOf(item.name) == -1;
          });
        });
      }
    }
    if(options.report) {
      require('./report-package.js')(list);
    }

    done();
  });

  // update files by removing files in removed
  list.files = list.files.filter(function(obj) {
    return removed.indexOf(obj.name) == -1;
  });

  if(options.progress) {
    progress = new ProgressBar('[:bar] :current / :total :percent :etas', {
      complete: '=', incomplete: ' ', width: 20, total: list.files.length
    });
  }

  runner.parallel(packageTasks, {
      cacheEnabled: (options.cache ? true : false),
      cachePath: options['cache-path'],
      cacheMethod: options['cache-method'],
      output: (out ? out : process.stdout),
      limit: options.jobs,
      end: (out !== process.stdout ? true : false), // e.g. no "end" for process.stdout
      onDone: function() {
        if(typeof onDone === 'function') {
          onDone();
        }
      }
  });

};
