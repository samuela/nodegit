const path = require("path");
const rootDir = path.join(__dirname, "../..");
const exec = require(path.join(rootDir, "./utils/execPromise"));

module.exports = async function getStatus() {
  try {
    const stdout = await exec("git submodule status", { cwd: rootDir });
    if (!stdout) {
      // In the case where we pull from npm they pre-init the submodules for
      // us and `git submodule status` returns empty-string. In that case
      // we'll just assume that we're good.
      return [];
    }

    async function getStatusPromiseFromLine(line) {
      const lineSections = line.trim().split(" ");
      const onNewCommit = !!~lineSections[0].indexOf("+");
      const needsInitialization = !!~lineSections[0].indexOf("-");
      const commitOid = lineSections[0].replace("+", "").replace("-", "");
      const name = lineSections[1];

      const workDirStatus = await exec("git status", {
        cwd: path.join(rootDir, name),
      });
      return {
        commitOid: commitOid,
        onNewCommit: onNewCommit,
        name: name,
        needsInitialization: needsInitialization,
        workDirDirty: !~workDirStatus
          .trim()
          .split("\n")
          .pop()
          .indexOf("nothing to commit"),
      };
    }

    return await Promise.all(
      stdout.trim().split("\n").map(getStatusPromiseFromLine)
    );
  } catch (_) {
    // In the case that NodeGit is required from another project via npm we
    // won't be able to run submodule commands but that's ok since the
    // correct version of libgit2 is published with nodegit.
  }
};
