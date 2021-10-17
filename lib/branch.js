const NodeGit = require("../");
const Branch = NodeGit.Branch;

const _remoteName = Branch.remoteName;

/**
 * Retrieve the Branch's Remote Name as a String.
 *
 *  @async
 * @param {Repository} repo The repo to get the remote name from
 * @param {String} the refname of the branch
 * @return {String} remote name as a string.
 */
Branch.remoteName = async function (repo, remoteRef) {
  const remoteNameBuffer = await _remoteName.call(this, repo, remoteRef);
  return remoteNameBuffer.toString();
};
