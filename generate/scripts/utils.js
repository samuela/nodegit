const fse = require("fs-extra");
const walk = require("walk");
const _ = require("lodash");

const fs = require("fs");
const path = require("path");

// Make a locally bound path joiner, (bound to generate).
var local = path.join.bind(null, __dirname, "../");

var util = {
  arrayTypeRegex: /\s\[\d+\]\s*/,
  pointerRegex: /\s*\*\s*/,
  doublePointerRegex: /\s*\*\*\s*/,

  readLocalFile: function (filePath) {
    return util.readFile(local(filePath));
  },

  readFile: function (filePath) {
    try {
      return fs.readFileSync(filePath).toString();
    } catch (unhandledException) {
      return "";
    }
  },

  writeLocalFile: function (filePath, content, header) {
    return util.writeFile(local(filePath), content, header);
  },

  writeFile: function (filePath, content, header) {
    try {
      if (typeof content == "object") {
        content = JSON.stringify(content, null, 2);
      }

      if (header) {
        var commentPrefix = ~header.indexOf(".gyp") ? "#" : "//";
        content =
          commentPrefix +
          " This is a generated file, modify: generate/templates/templates/" +
          header +
          "\n\n" +
          content;
      }

      fse.ensureFileSync(filePath);
      fse.writeFileSync(filePath, content);
      return true;
    } catch (exception) {
      return false;
    }
  },

  titleCase: function (str) {
    return str
      .split(/_|\//)
      .map(function (val, index) {
        if (val.length) {
          return val[0].toUpperCase() + val.slice(1);
        }

        return val;
      })
      .join("");
  },

  camelCase: _.camelCase,

  getFilePathsRelativeToDir: function (dir) {
    const files = [];
    const walker = walk.walk(dir, { followLinks: false });
    if (!util.isDirectory(dir)) {
      return Promise.resolve([]);
    }

    return new Promise(function (resolve, reject) {
      walker.on("file", function (root, stat, next) {
        files.push(path.relative(dir, path.join(root, stat.name)));
        next();
      });

      walker.on("end", function () {
        resolve(files);
      });

      walker.on("errors", function () {
        reject();
      });
    });
  },

  isFile: function (path) {
    var isFile;
    try {
      isFile = fse.statSync(path).isFile();
    } catch (e) {
      isFile = false;
    }

    return isFile;
  },

  isDirectory: function (path) {
    var isDirectory;
    try {
      isDirectory = fse.statSync(path).isDirectory();
    } catch (e) {
      isDirectory = false;
    }

    return isDirectory;
  },

  isPointer: function (type) {
    return util.pointerRegex.test(type) || util.doublePointerRegex.test(type);
  },

  isDoublePointer: function (type) {
    return util.doublePointerRegex.test(type);
  },

  syncDirs: async function (fromDir, toDir) {
    const [toFilePaths, fromFilePaths] = await Promise.all([
      util.getFilePathsRelativeToDir(toDir),
      util.getFilePathsRelativeToDir(fromDir),
    ]);
    // Delete files that aren't in fromDir
    await Promise.all(
      toFilePaths.map(function (filePath) {
        if (!util.isFile(path.join(fromDir, filePath))) {
          return fse.remove(path.join(toDir, filePath));
        } else {
          return Promise.resolve();
        }
      })
    );
    // Copy files that don't exist in toDir or have different contents
    await Promise.all(
      fromFilePaths.map(function (filePath) {
        const toFilePath = path.join(toDir, filePath);
        const fromFilePath = path.join(fromDir, filePath);
        if (
          !util.isFile(toFilePath) ||
          util.readFile(toFilePath) !== util.readFile(fromFilePath)
        ) {
          return fse.copy(fromFilePath, toFilePath);
        } else {
          return Promise.resolve();
        }
      })
    );
  },
};

module.exports = util;
