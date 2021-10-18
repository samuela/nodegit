const NodeGit = require("../");
const Revwalk = NodeGit.Revwalk;

Object.defineProperty(Revwalk.prototype, "repo", {
  get: function () {
    return this.repository();
  },
  configurable: true,
});

const _sorting = Revwalk.prototype.sorting;
/**
 * @typedef historyEntry
 * @type {Object}
 * @property {Commit} commit the commit for this entry
 * @property {Number} status the status of the file in the commit
 * @property {String} newName the new name that is provided when status is
 *                            renamed
 * @property {String} oldName the old name that is provided when status is
 *                            renamed
 */
const fileHistoryWalk = Revwalk.prototype.fileHistoryWalk;
/**
 * @param {String} filePath
 * @param {Number} max_count
 * @async
 * @return {Array<historyEntry>}
 */
Revwalk.prototype.fileHistoryWalk = fileHistoryWalk;

/**
 * Get a number of commits.
 *
 * @async
 * @param  {Number} count (default: 10)
 * @return {Array<Commit>}
 */
Revwalk.prototype.getCommits = async function (count) {
  count = count || 10;
  var promises = [];
  const walker = this;

  async function walkCommitsCount(count) {
    if (count === 0) {
      return;
    }

    try {
      const oid = await walker.next();
      promises.push(walker.repo.getCommit(oid));
      return await walkCommitsCount(count - 1);
    } catch (error) {
      if (error.errno !== NodeGit.Error.CODE.ITEROVER) {
        throw error;
      }
    }
  }

  await walkCommitsCount(count);
  return await Promise.all(promises);
};

/**
 * Walk the history grabbing commits until the checkFn called with the
 * current commit returns false.
 *
 * @async
 * @param  {Function} checkFn function returns false to stop walking
 * @return {Array}
 */
Revwalk.prototype.getCommitsUntil = async function (checkFn) {
  var commits = [];
  const walker = this;

  async function walkCommitsCb() {
    try {
      const oid = await walker.next();
      const commit = await walker.repo.getCommit(oid);
      commits.push(commit);
      if (checkFn(commit)) {
        return await walkCommitsCb();
      }
    } catch (error) {
      if (error.errno !== NodeGit.Error.CODE.ITEROVER) {
        throw error;
      }
    }
  }
  await walkCommitsCb();
  return commits;
};

/**
 * Set the sort order for the revwalk. This function takes variable arguments
 * like `revwalk.sorting(NodeGit.RevWalk.Topological, NodeGit.RevWalk.Reverse).`
 *
 * @param {Number} sort
 */
Revwalk.prototype.sorting = function () {
  var sort = 0;

  for (var i = 0; i < arguments.length; i++) {
    sort |= arguments[i];
  }

  _sorting.call(this, sort);
};

/**
 * Walk the history from the given oid. The callback is invoked for each commit;
 * When the walk is over, the callback is invoked with `(null, null)`.
 *
 * @param  {Oid} oid
 * @param  {Function} callback
 */
Revwalk.prototype.walk = async function (oid, callback) {
  var revwalk = this;
  this.push(oid);

  async function walk() {
    try {
      const oid = await revwalk.next();
      if (!oid) {
        if (typeof callback === "function") {
          return callback();
        }
        return;
      }

      const commit = await revwalk.repo.getCommit(oid);
      if (typeof callback === "function") {
        callback(null, commit);
      }

      await walk();
    } catch (error) {
      callback(error);
    }
  }

  await walk();
};
