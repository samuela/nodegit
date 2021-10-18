const path = require("path");
const rootDir = path.join(__dirname, "../..");

const gitExecutableLocation = require(path.join(
  rootDir,
  "./utils/gitExecutableLocation"
));
const submoduleStatus = require("./getStatus");

const exec = require(path.join(rootDir, "./utils/execPromise"));

module.exports = async function submodules() {
  try {
    await gitExecutableLocation();
  } catch (_) {
    console.error(
      "[nodegit] ERROR - Compilation of NodeGit requires git " +
        "CLI to be installed and on the path"
    );

    throw new Error("git CLI is not installed or not on the path");
  }

  console.log("[nodegit] Checking submodule status");
  const statuses = await submoduleStatus();

  function printSubmodule(submoduleName) {
    console.log("\t" + submoduleName);
  }

  const dirtySubmodules = statuses
    .filter((status) => status.workDirDirty && !status.needsInitialization)
    .map((dirtySubmodule) => dirtySubmodule.name);

  if (dirtySubmodules.length) {
    console.error("[nodegit] ERROR - Some submodules have uncommited changes:");
    dirtySubmodules.forEach(printSubmodule);
    console.error(
      "\nThey must either be committed or discarded before we build"
    );

    throw new Error("Dirty Submodules: " + dirtySubmodules.join(" "));
  }

  const outOfSyncSubmodules = statuses
    .filter((status) => status.onNewCommit && !status.needsInitialization)
    .map((outOfSyncSubmodule) => outOfSyncSubmodule.name);

  if (outOfSyncSubmodules.length) {
    console.warn(
      "[nodegit] WARNING - Some submodules are pointing to an new commit:"
    );
    outOfSyncSubmodules.forEach(printSubmodule);
    console.warn("\nThey will not be updated.");
  }

  for (const status of statuses.filter((s) => !s.onNewCommit)) {
    console.log("[nodegit] Initializing submodule", status.name);
    await exec("git submodule update --init --recursive " + status.name);
  }
};
