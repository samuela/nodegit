const fork = require("child_process").fork;
const path = require("path");
const fs = require("fs");

var bin = "./node_modules/.bin/nyc";
var cov = [
  "mocha",
  "--timeout=15000",
  "--report=lcov",
  "--dir=test/coverage/js",
  "--",
];

if (process.platform === "win32") {
  bin = "./node_modules/mocha/bin/mocha";
  cov = [];
}

const args = cov.concat(["test/runner", "test/tests"]);

if (
  !process.env.APPVEYOR &&
  !process.env.TRAVIS &&
  !process.env.GITHUB_ACTION
) {
  const local = path.join.bind(path, __dirname);
  const dummyPath = local("home");
  process.env.HOME = dummyPath;
  process.env.USERPROFILE = dummyPath;
}

// unencrypt test keys
function unencryptKey(fileName) {
  const base64Contents = fs.readFileSync(
    path.join(__dirname, fileName + ".enc"),
    "utf8"
  );
  const asciiContents = Buffer.from(base64Contents, "base64").toString("ascii");
  fs.writeFileSync(path.join(__dirname, fileName), asciiContents, "utf8");
}
unencryptKey("id_rsa");
unencryptKey("nodegit-test-rsa");

fork(bin, args, { cwd: path.join(__dirname, "../") }).on("close", process.exit);
