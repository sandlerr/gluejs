var fs = require('fs'),
    util = require('util'),
    runner = require('../../runner.js'),
    // tasks
    inferPackages = require('../../tree-tasks/infer-packages.js'),
    filterNpm = require('../../tree-tasks/filter-npm.js'),
    filterPackages = require('../../tree-tasks/filter-packages.js'),
    wrapCommonJs = require('../../file-tasks/wrap-commonjs-web.js');

// this runner concatenates the files to stdout after running wrap-commonjs-web
module.exports = function(tree, options) {
  if(!options) {
    options = {};
  }
  // unpack options
  var exportVariableName = options.exportname || 'foo',
      packageRootFileName = options.main || 'index.js';

  // exclude files using the npmjs defaults for file and path exclusions
  filterNpm(tree);

  // annotate with file-level tasks
  /*
  annotateWithTask(tree, [
    require('../../file-tasks/wrap-commonjs-web.js')
  ]);
  */

  // run tree level tasks

  // - generate `.packages` from `.files` (by grouping the set of `.files` into distinct dependencies)
  //   ... and infer the package main file
  inferPackages(tree);
  // - for each package, apply excludes (package.json.files, .npmignore, .gitignore)
  filterPackages(tree);

  // filter out non-JS files
  var removed = [];
  // find the ignore files (applying them in the correct order)
  function traverse(packageObj) {
    packageObj.files = packageObj.files.filter(function(name) {
      var result = (/\.js$/.test(name));
      // also update tree.files
      if(!result) {
        removed.push((packageObj.basepath ? packageObj.basepath : '')  + name);
      }
      return result;
    });
  }

  tree.packages.forEach(traverse);

  // update files
  tree.files = tree.files.filter(function(obj) {
    return removed.indexOf(obj.name) == -1;
  });

  // produce the file

  // top level boundary
  process.stdout.write('(function(){');
  // the require() implementation
  process.stdout.write(fs.readFileSync(__dirname + '/resources/require.new.min.js'));
  // the registry definition
  process.stdout.write('\nrequire.m = [];\n');

  // for each module, write `require.m[n] = { normalizedName: .. code .. , };`
  var current = 0;

  function next() {
    var packageObj = tree.packages[current],
        innerCurrent = 0;

    process.stdout.write('/* -- ' + (packageObj.name ? packageObj.name : 'root') + ' -- */\n');

    process.stdout.write('require.m['+current+'] = { \n');

    function inner() {
      var fullpath = (packageObj.basepath ? packageObj.basepath : '') +
                     (packageObj.files[innerCurrent] ? packageObj.files[innerCurrent] : innerCurrent);

      process.stdout.write(JSON.stringify(packageObj.files[innerCurrent]) + ': ');

      var last = runner({ stdout: fs.createReadStream(fullpath) }, [ wrapCommonJs ]);
      last.stdout.on('end', function() {

        if(innerCurrent < packageObj.files.length) {
          process.stdout.write(',\n');
        }

        if(innerCurrent == packageObj.files.length) {

          process.stdout.write('};\n');

          if(current == tree.packages.length){
            onEnd();
            return;
          } else {
            next();
            return;
          }

        }
        inner();
      });

      // need to do this here so we can catch the second-to-last stream's "end" event;
      last.stdout.pipe(process.stdout);

      innerCurrent++;
    }

    inner();



    current++;
  }

  next();

  function onEnd() {
    // export the package root into `window`
    process.stdout.write(exportVariableName + ' = require(\'' +  packageRootFileName + '\');\n');
    // finally, close the package file
    process.stdout.write('}());');

    delete tree.structured;

//    console.log(util.inspect(tree, false, 20, true));
  }
};