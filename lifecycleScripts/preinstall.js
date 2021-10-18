var path = require("path");
var local = path.join.bind(path, __dirname);

var exec = require(local("../utils/execPromise"));

module.exports = async function prepareForBuild() {
  console.log("[nodegit] Running pre-install script");

  var npm2workaround = false;
  try {
    npm2workaround = (await exec("npm -v")).split(".")[0] < 3;
  } catch (_) {
    // We're installing via yarn, so don't care about compability with npm@2
  }
  if (npm2workaround) {
    console.log("[nodegit] npm@2 installed, pre-loading required packages");
    await exec("npm install --ignore-scripts");
  }

  const submodules = require(local("submodules"));
  const generate = require(local("../generate"));
  await submodules();
  await generate();
};

// Called on the command line
if (require.main === module) {
  module.exports().catch(function (e) {
    console.error("[nodegit] ERROR - Could not finish preinstall");
    console.error(e);
    process.exit(1);
  });
}
