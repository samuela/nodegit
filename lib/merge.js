const NodeGit = require("../");

const Merge = NodeGit.Merge;
const _commits = Merge.commits;
const _merge = Merge.merge;

/**
 * Merge 2 commits together and create an new index that can
 * be used to create a merge commit.
 *
 * @param {Repository} repo Repository that contains the given commits
 * @param {Commit} ourCommit The commit that reflects the destination tree
 * @param {Commit} theirCommit The commit to merge into ourCommit
 * @param {MergeOptions} [options] The merge tree options (null for default)
 */
Merge.commits = async function (repo, ourCommit, theirCommit, options) {
  const commits = await Promise.all([
    repo.getCommit(ourCommit),
    repo.getCommit(theirCommit),
  ]);
  return await _commits.call(this, repo, commits[0], commits[1], options);
};

/**
 * Merge a commit into HEAD and writes the results to the working directory.
 *
 * @param {Repository} repo Repository that contains the given commits
 * @param {AnnotatedCommit} theirHead The annotated commit to merge into HEAD
 * @param {MergeOptions} [mergeOpts] The merge tree options (null for default)
 * @param {CheckoutOptions} [checkoutOpts] The checkout options
 *                                         (null for default)
 */
Merge.merge = function (repo, theirHead, mergeOpts, checkoutOpts) {
  // Even though git_merge takes an array of annotated_commits, it expects
  // exactly one to have been passed in or it will throw an error...  ¯\_(ツ)_/¯
  const theirHeads = [theirHead];

  return _merge.call(
    this,
    repo,
    theirHeads,
    theirHeads.length,
    mergeOpts,
    checkoutOpts
  );
};
