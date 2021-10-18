const fse = require("fs-extra");
const fp = require("lodash/fp");
const NodeGit = require("../");
const Blob = NodeGit.Blob;
const Checkout = NodeGit.Checkout;
const Commit = NodeGit.Commit;
const shallowClone = NodeGit.Utils.shallowClone;
const path = require("path");
const Filter = NodeGit.Filter;
const FilterList = NodeGit.FilterList;
const Reference = NodeGit.Reference;
const Remote = NodeGit.Remote;
const Repository = NodeGit.Repository;
const Revwalk = NodeGit.Revwalk;
const Status = NodeGit.Status;
const StatusFile = NodeGit.StatusFile;
const StatusList = NodeGit.StatusList;
const Submodule = NodeGit.Submodule;
const Tag = NodeGit.Tag;
const Tree = NodeGit.Tree;
const TreeBuilder = NodeGit.Treebuilder;

const _discover = Repository.discover;
const _fetchheadForeach = Repository.prototype.fetchheadForeach;
const _mergeheadForeach = Repository.prototype.mergeheadForeach;

/* jshint -W014 */
// Disable the "Misleading line break before '?'" warning. It's mostly annoying
// and doesn't play nicely with Prettier's auto-formatting.

async function applySelectedLinesToTarget(
  originalContent,
  newLines,
  pathHunks,
  isStaged,
  reverse
) {
  // 43: ascii code for '+'
  // 45: ascii code for '-'
  var lineTypes = {
    ADDED: !reverse ? 43 : 45,
    DELETED: !reverse ? 45 : 43,
  };
  var newContent = "";
  var oldIndex = 0;
  var linesPromises = [];

  var oldLines = originalContent.toString().split("\n");

  // if no selected lines were sent, return the original content
  if (!newLines || newLines.length === 0) {
    return originalContent;
  }

  function lineEqualsFirstNewLine(hunkLine) {
    return (
      hunkLine.oldLineno() === newLines[0].oldLineno() &&
      hunkLine.newLineno() === newLines[0].newLineno()
    );
  }

  async function processSelectedLine(hunkLine) {
    // if this hunk line is a selected line find the selected line
    const newLine = newLines.filter(function (nLine) {
      return (
        hunkLine.oldLineno() === nLine.oldLineno() &&
        hunkLine.newLineno() === nLine.newLineno()
      );
    });

    if (hunkLine.content().indexOf("\\ No newline at end of file") !== -1) {
      return false;
    }

    // determine what to add to the new content
    if (
      (isStaged && newLine && newLine.length > 0) ||
      (!isStaged && (!newLine || newLine.length === 0))
    ) {
      if (hunkLine.origin() !== lineTypes.ADDED) {
        newContent += hunkLine.content();
      }
      if (
        (isStaged && hunkLine.origin() !== lineTypes.DELETED) ||
        (!isStaged && hunkLine.origin() !== lineTypes.ADDED)
      ) {
        oldIndex++;
      }
    } else {
      switch (hunkLine.origin()) {
        case lineTypes.ADDED:
          newContent += hunkLine.content();
          if (isStaged) {
            oldIndex++;
          }
          break;
        case lineTypes.DELETED:
          if (!isStaged) {
            oldIndex++;
          }
          break;
        default:
          newContent += oldLines[oldIndex++];
          if (oldIndex < oldLines.length) {
            newContent += "\n";
          }
          break;
      }
    }
  }

  // find the affected hunk
  pathHunks.forEach(function (pathHunk) {
    linesPromises.push(pathHunk.lines());
  });

  const results = await Promise.all(linesPromises);

  for (var i = 0; i < results.length && newContent.length < 1; i++) {
    var hunkStart =
      isStaged || reverse ? pathHunks[i].newStart() : pathHunks[i].oldStart();
    var lines = results[i];
    if (lines.filter(lineEqualsFirstNewLine).length > 0) {
      // add content that is before the hunk
      while (hunkStart > oldIndex + 1) {
        newContent += oldLines[oldIndex++] + "\n";
      }

      // modify the lines of the hunk according to the selection
      lines.forEach(processSelectedLine);

      // add the rest of the file
      while (oldLines.length > oldIndex) {
        newContent +=
          oldLines[oldIndex++] + (oldLines.length > oldIndex ? "\n" : "");
      }
    }
  }

  return newContent;
}

async function getPathHunks(
  repo,
  index,
  filePath,
  isStaged,
  additionalDiffOptions
) {
  const diffOptions = additionalDiffOptions
    ? { flags: additionalDiffOptions }
    : undefined;

  var diff;
  if (isStaged) {
    const commit = await repo.getHeadCommit();
    const tree = await commit.getTree();
    diff = await NodeGit.Diff.treeToIndex(repo, tree, index, diffOptions);
  } else {
    diff = await NodeGit.Diff.indexToWorkdir(repo, index, {
      flags:
        NodeGit.Diff.OPTION.SHOW_UNTRACKED_CONTENT |
        NodeGit.Diff.OPTION.RECURSE_UNTRACKED_DIRS |
        (additionalDiffOptions || 0),
    });
  }

  const status = await NodeGit.Status.file(repo, filePath);
  if (
    !(status & NodeGit.Status.STATUS.WT_MODIFIED) &&
    !(status & NodeGit.Status.STATUS.INDEX_MODIFIED)
  ) {
    throw new Error("Selected staging is only available on modified files.");
  }
  const patches = await diff.patches();

  const pathPatch = patches.filter(
    (patch) => patch.newFile().path() === filePath
  );

  if (pathPatch.length !== 1) {
    throw new Error("No differences found for this file.");
  }

  return pathPatch[0].hunks();
}

function getReflogMessageForCommit(commit) {
  var parentCount = commit.parentcount();
  var summary = commit.summary();
  var commitType;

  if (parentCount >= 2) {
    commitType = " (merge)";
  } else if (parentCount == 0) {
    commitType = " (initial)";
  } else {
    commitType = "";
  }

  return `commit${commitType}: ${summary}`;
}

/**
 * Goes through a rebase's rebase operations and commits them if there are
 * no merge conflicts
 *
 * @param {Repository}  repository    The repository that the rebase is being
 *                                    performed in
 * @param {Rebase}      rebase        The current rebase being performed
 * @param {Signature}   signature     Identity of the one performing the rebase
 * @param {Function}    beforeNextFn  Callback to be called before each
 *                                    invocation of next(). If the callback
 *                                    returns a promise, the next() will be
 *                                    called when the promise resolves.
 * @param {Function}   beforeFinishFn Callback called before the invocation
 *                                    of finish(). If the callback returns a
 *                                    promise, finish() will be called when the
 *                                    promise resolves. This callback will be
 *                                    provided a detailed overview of the rebase
 * @return {Int|Index} An error code for an unsuccesful rebase or an index for
 *                     a rebase with conflicts
 */
async function performRebase(
  repository,
  rebase,
  signature,
  beforeNextFn,
  beforeFinishFn
) {
  /* In the case of FF merges and a beforeFinishFn, this will fail
   * when looking for 'rewritten' so we need to handle that case.
   */
  async function readRebaseMetadataFile(fileName, continueOnError) {
    try {
      return fp.trim(
        await fse.readFile(
          path.join(repository.path(), "rebase-merge", fileName),
          { encoding: "utf8" }
        )
      );
    } catch (err) {
      if (continueOnError) {
        return null;
      }
      throw err;
    }
  }

  function calcHeadName(input) {
    return input.replace(/refs\/heads\/(.*)/, "$1");
  }

  async function getPromise() {
    try {
      await rebase.next();
      const index = await repository.refreshIndex();
      if (index.hasConflicts()) {
        throw index;
      }
      await rebase.commit(null, signature);
      await performRebase(
        repository,
        rebase,
        signature,
        beforeNextFn,
        beforeFinishFn
      );
    } catch (error) {
      if (error && error.errno === NodeGit.Error.CODE.ITEROVER) {
        const calcRewritten = fp.cond([
          [fp.isEmpty, fp.constant(null)],
          [fp.stubTrue, fp.flow([fp.split("\n"), fp.map(fp.split(" "))])],
        ]);

        if (beforeFinishFn) {
          const [
            ontoName,
            ontoSha,
            originalHeadName,
            originalHeadSha,
            rewritten,
          ] = await Promise.all([
            readRebaseMetadataFile("onto_name"),
            readRebaseMetadataFile("onto"),
            readRebaseMetadataFile("head-name").then(calcHeadName),
            readRebaseMetadataFile("orig-head"),
            readRebaseMetadataFile("rewritten", true).then(calcRewritten),
          ]);
          await beforeFinishFn({
            ontoName,
            ontoSha,
            originalHeadName,
            originalHeadSha,
            rebase,
            rewritten,
          });
        }

        return await rebase.finish(signature);
      } else {
        throw error;
      }
    }
  }

  if (beforeNextFn) {
    await beforeNextFn(rebase);
  }

  return await getPromise();
}

/**
 * Look for a git repository, returning its path.
 *
 * @async
 * @param {String} startPath The base path where the lookup starts.
 * @param {Number} acrossFs If non-zero, then the lookup will not stop when a
                            filesystem device change is detected while exploring
                            parent directories.
 * @param {String} ceilingDirs A list of absolute symbolic link free paths.
                              the search will stop if any of these paths
                              are hit. This may be set to null
 * @return {String} Path of the git repository
 */
Repository.discover = async function (startPath, acrossFs, ceilingDirs) {
  const foundPath = await _discover(startPath, acrossFs, ceilingDirs);
  return path.resolve(foundPath);
};

Repository.getReferences = async function (repo, type, refNamesOnly) {
  const refList = await repo.getReferences();
  const filteredRefList = refList.filter(
    (reference) => type === Reference.TYPE.ALL || reference.type === type
  );
  return refNamesOnly
    ? filteredRefList.map((reference) => reference.name())
    : filteredRefList;
};

/**
 * This will set the HEAD to point to the local branch and then attempt
 * to update the index and working tree to match the content of the
 * latest commit on that branch
 *
 * @async
 * @param {String|Reference} branch the branch to checkout
 * @param {Object|CheckoutOptions} opts the options to use for the checkout
 */
Repository.prototype.checkoutBranch = async function (branch, opts) {
  const ref = await this.getReference(branch);
  return ref.isBranch() ? await this.checkoutRef(ref, opts) : false;
};

/**
 * This will set the HEAD to point to the reference and then attempt
 * to update the index and working tree to match the content of the
 * latest commit on that reference
 *
 * @async
 * @param {Reference} reference the reference to checkout
 * @param {Object|CheckoutOptions} opts the options to use for the checkout
 */
Repository.prototype.checkoutRef = async function (reference, opts) {
  opts = opts || {};

  opts.checkoutStrategy =
    opts.checkoutStrategy ||
    NodeGit.Checkout.STRATEGY.SAFE | NodeGit.Checkout.STRATEGY.RECREATE_MISSING;

  const commit = await this.getReferenceCommit(reference.name());
  const tree = await commit.getTree();
  await Checkout.tree(this, tree, opts);
  return await this.setHead(reference.name());
};

/**
 * Continues an existing rebase
 *
 * @async
 * @param {Signature}  signature     Identity of the one performing the rebase
 * @param {Function}   beforeNextFn  Callback to be called before each step
 *                                   of the rebase. If the callback returns a
 *                                   promise, the rebase will resume when the
 *                                   promise resolves. The rebase object is
 *                                   is passed to the callback.
 * @param {Function}   beforeFinishFn Callback called before the invocation
 *                                    of finish(). If the callback returns a
 *                                    promise, finish() will be called when the
 *                                    promise resolves. This callback will be
 *                                    provided a detailed overview of the rebase
 * @param {RebaseOptions} rebaseOptions Options to initialize the rebase object
 *                                      with
 * @return {Oid|Index}  A commit id for a succesful merge or an index for a
 *                      rebase with conflicts
 */
Repository.prototype.continueRebase = async function (
  signature,
  beforeNextFn,
  beforeFinishFn,
  rebaseOptions
) {
  if (!signature) {
    signature = await this.defaultSignature();
  }

  const index = await this.refreshIndex();
  if (index.hasConflicts()) {
    throw index;
  }
  const rebase = await NodeGit.Rebase.open(this, rebaseOptions);
  try {
    await rebase.commit(null, signature);
  } catch (e) {
    // If the first commit on continueRebase is a "patch already applied" error,
    // interpret that as an explicit "skip commit" and ignore the error.
    const errno = fp.get(["errno"], e);
    if (errno === NodeGit.Error.CODE.EAPPLIED) {
      return;
    }
    throw e;
  }
  const error = await performRebase(
    this,
    rebase,
    signature,
    beforeNextFn,
    beforeFinishFn
  );
  if (error) {
    throw error;
  }

  return await this.getBranchCommit("HEAD");
};

/**
 * Creates a branch with the passed in name pointing to the commit
 *
 * @async
 * @param {String} name Branch name, e.g. "master"
 * @param {Commit|String|Oid} commit The commit the branch will point to
 * @param {Boolean} force Overwrite branch if it exists
 * @return {Reference}
 */
Repository.prototype.createBranch = async function (name, commit, force) {
  if (commit instanceof Commit) {
    return await NodeGit.Branch.create(this, name, commit, force ? 1 : 0);
  } else {
    const commitObj = await this.getCommit(commit);
    return await NodeGit.Branch.create(this, name, commitObj, force ? 1 : 0);
  }
};

/**
 * Create a blob from a buffer
 *
 * @async
 * @param {Buffer} buffer
 * @return {Oid}
 */
Repository.prototype.createBlobFromBuffer = function (buffer) {
  return Blob.createFromBuffer(this, buffer, buffer.length);
};

/**
 * Create a commit
 *
 * @async
 * @param {String} updateRef
 * @param {Signature} author
 * @param {Signature} committer
 * @param {String} message
 * @param {Oid|String} Tree
 * @param {Array} parents
 * @return {Oid} The oid of the commit
 */
Repository.prototype.createCommit = async function (
  updateRef,
  author,
  committer,
  message,
  tree,
  parents
) {
  var repo = this;
  var promises = [];

  parents = parents || [];

  promises.push(repo.getTree(tree));

  parents.forEach(function (parent) {
    promises.push(repo.getCommit(parent));
  });

  const results = await Promise.all(promises);
  tree = results[0];

  // Get the normalized values for our input into the function
  const parentsLength = parents.length;
  parents = [];

  for (var i = 0; i < parentsLength; i++) {
    parents.push(results[i + 1]);
  }

  return Commit.create(
    repo,
    updateRef,
    author,
    committer,
    null /* use default message encoding */,
    message,
    tree,
    parents.length,
    parents
  );
};

/**
 * Create a commit
 *
 * @async
 * @param {Signature} author
 * @param {Signature} committer
 * @param {String} message
 * @param {Oid|String} treeOid
 * @param {Array} parents
 * @return {String} The content of the commit object
 *                  as a string
 */
Repository.prototype.createCommitBuffer = async function (
  author,
  committer,
  message,
  treeOid,
  parents
) {
  const repo = this;
  const promises = (parents || []).reduce(
    function (acc, parent) {
      acc.push(repo.getCommit(parent));
      return acc;
    },
    [repo.getTree(treeOid)]
  );

  const [tree, ...parentCommits] = await Promise.all(promises);
  return await Commit.createBuffer(
    repo,
    author,
    committer,
    null /* use default message encoding */,
    message,
    tree,
    parentCommits.length,
    parentCommits
  );
};

/**
 * Create a commit that is digitally signed
 *
 * @async
 * @param {String} updateRef
 * @param {Signature} author
 * @param {Signature} committer
 * @param {String} message
 * @param {Tree|Oid|String} Tree
 * @param {Array} parents
 * @param {Function} onSignature Callback to be called with string to be signed
 * @return {Oid} The oid of the commit
 */
Repository.prototype.createCommitWithSignature = async function (
  updateRef,
  author,
  committer,
  message,
  tree,
  parents,
  onSignature
) {
  var repo = this;
  var promises = [];
  var commitContent;
  var skippedSigning;

  parents = parents || [];

  promises.push(repo.getTree(tree));

  parents.forEach(function (parent) {
    promises.push(repo.getCommit(parent));
  });

  async function createCommit() {
    const results = await Promise.all(promises);
    tree = results[0];

    // Get the normalized values for our input into the function
    var parentsLength = parents.length;
    parents = [];

    for (var i = 0; i < parentsLength; i++) {
      parents.push(results[i + 1]);
    }

    const commitContentResult = await Commit.createBuffer(
      repo,
      author,
      committer,
      null /* use default message encoding */,
      message,
      tree,
      parents.length,
      parents
    );

    commitContent = commitContentResult;
    if (!commitContent.endsWith("\n")) {
      commitContent += "\n";
    }
    const { code, field, signedData } = onSignature(commitContent);
    switch (code) {
      case NodeGit.Error.CODE.OK:
        return await Commit.createWithSignature(
          repo,
          commitContent,
          signedData,
          field
        );
      case NodeGit.Error.CODE.PASSTHROUGH:
        skippedSigning = true;
        return await Commit.create(
          repo,
          updateRef,
          author,
          committer,
          null /* use default message encoding */,
          message,
          tree,
          parents.length,
          parents
        );
      default: {
        const error = new Error(
          "Repository.prototype.createCommitWithSignature " +
            `threw with error code ${code}`
        );
        error.errno = code;
        throw error;
      }
    }
  }

  const commitOid = await createCommit();
  if (updateRef && !skippedSigning) {
    const commitResult = await repo.getCommit(commitOid);
    await Reference.updateTerminal(
      repo,
      updateRef,
      commitOid,
      getReflogMessageForCommit(commitResult),
      committer
    );
  }
  return commitOid;
};

/**
 * Creates a new commit on HEAD from the list of passed in files
 *
 * @async
 * @param {Array} filesToAdd
 * @param {Signature} author
 * @param {Signature} committer
 * @param {String} message
 * @return {Oid} The oid of the new commit
 */
Repository.prototype.createCommitOnHead = async function (
  filesToAdd,
  author,
  committer,
  message
) {
  const index = await this.refreshIndex();
  if (!filesToAdd) {
    filesToAdd = [];
  }

  for (const fileToAdd of filesToAdd) {
    await index.addByPath(fileToAdd);
  }
  await index.write();
  const treeOid = await index.writeTree();
  var parent = await this.getHeadCommit();
  if (parent !== null) {
    // To handle a fresh repo with no commits
    parent = [parent];
  }
  return await this.createCommit(
    "HEAD",
    author,
    committer,
    message,
    treeOid,
    parent
  );
};

/**
 * Creates a new lightweight tag
 *
 * @async
 * @param {String|Oid} String sha or Oid
 * @param {String} name the name of the tag
 * @return {Reference}
 */
Repository.prototype.createLightweightTag = async function (oid, name) {
  const commit = await Commit.lookup(this, oid);
  // Final argument is `force` which overwrites any previous tag
  await Tag.createLightweight(this, name, commit, 0);
  return await Reference.lookup(this, "refs/tags/" + name);
};

/**
 * Instantiate a new revision walker for browsing the Repository"s history.
 * See also `Commit.prototype.history()`
 *
 * @return {Revwalk}
 */
Repository.prototype.createRevWalk = function () {
  return Revwalk.create(this);
};

/**
 * Creates a new annotated tag
 *
 * @async
 * @param {String|Oid} String sha or Oid
 * @param {String} name the name of the tag
 * @param {String} message the description that will be attached to the
 * annotated tag
 * @return {Tag}
 */
Repository.prototype.createTag = async function (oid, name, message) {
  const signature = await this.getDefaultSignature();
  const commit = await Commit.lookup(this, oid);
  // Final argument is `force` which overwrites any previous tag
  const tagOid = await Tag.create(this, name, commit, signature, message, 0);
  return await this.getTag(tagOid);
};

/**
 * Gets the default signature for the default user and now timestamp
 *
 * @async
 * @return {Signature}
 */
Repository.prototype.defaultSignature = async function () {
  try {
    const result = await NodeGit.Signature.default(this);
    return !result || !result.name()
      ? NodeGit.Signature.now("unknown", "unknown@example.com")
      : result;
  } catch (_) {
    return NodeGit.Signature.now("unknown", "unknown@example.com");
  }
};

/**
 * Deletes a tag from a repository by the tag name.
 *
 * @async
 * @param {String} Short or full tag name
 */
Repository.prototype.deleteTagByName = function (name) {
  var repository = this;

  name = ~name.indexOf("refs/tags/") ? name.substr(10) : name;

  return Tag.delete(repository, name);
};

/**
 * Discard line selection of a specified file.
 * Assumes selected lines are unstaged.
 *
 * @async
 * @param {String} filePath The relative path of this file in the repo
 * @param {Array} selectedLines The array of DiffLine objects
 *                            selected for discarding
 * @return {Number} 0 or an error code
 */
Repository.prototype.discardLines = async function (
  filePath,
  selectedLines,
  additionalDiffOptions
) {
  const fullFilePath = path.join(this.workdir(), filePath);
  const index = await this.refreshIndex();

  var filterList = await FilterList.load(
    this,
    null,
    filePath,
    Filter.MODE.CLEAN,
    Filter.FLAG.DEFAULT
  );

  const originalContent = filterList
    ? await filterList.applyToFile(this, filePath)
    : await fse.readFile(fullFilePath, "utf8");
  const hunks = await getPathHunks(
    this,
    index,
    filePath,
    false,
    additionalDiffOptions
  );
  const newContent = await applySelectedLinesToTarget(
    originalContent,
    selectedLines,
    hunks,
    false,
    true
  );

  filterList = await FilterList.load(
    this,
    null,
    filePath,
    Filter.MODE.SMUDGE,
    Filter.FLAG.DEFAULT
  );

  /* jshint -W053 */
  // We need the constructor for the check in NodeGit's C++ layer
  // to accept an object, and this seems to be a nice way to do it
  const filteredContent = filterList
    ? await filterList.applyToData(new String(newContent))
    : newContent;
  /* jshint +W053 */

  return await fse.writeFile(fullFilePath, filteredContent);
};

/**
 * Fetches from a remote
 *
 * @async
 * @param {String|Remote} remote
 * @param {Object|FetchOptions} fetchOptions Options for the fetch, includes
 *                                           callbacks for fetching
 */
Repository.prototype.fetch = async function (remote, fetchOptions) {
  const remoteObj = await this.getRemote(remote);
  await remoteObj.fetch(null, fetchOptions, "Fetch from " + remoteObj);
  return await remoteObj.disconnect();
};

/**
 * Fetches from all remotes. This is done in series due to deadlocking issues
 * with fetching from many remotes that can happen.
 *
 * @async
 * @param {Object|FetchOptions} fetchOptions Options for the fetch, includes
 *                                           callbacks for fetching
 */
Repository.prototype.fetchAll = async function (fetchOptions) {
  function createCallbackWrapper(fn, remote) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      args.push(remote);

      return fn.apply(this, args);
    }.bind(this);
  }

  fetchOptions = fetchOptions || {};

  var remoteCallbacks = fetchOptions.callbacks || {};

  var credentials = remoteCallbacks.credentials;
  var certificateCheck = remoteCallbacks.certificateCheck;
  var transferProgress = remoteCallbacks.transferProgress;

  const remotes = await this.getRemoteNames();
  for (const remote of remotes) {
    var wrappedFetchOptions = shallowClone(fetchOptions);
    var wrappedRemoteCallbacks = shallowClone(remoteCallbacks);

    if (credentials) {
      wrappedRemoteCallbacks.credentials = createCallbackWrapper(
        credentials,
        remote
      );
    }

    if (certificateCheck) {
      wrappedRemoteCallbacks.certificateCheck = createCallbackWrapper(
        certificateCheck,
        remote
      );
    }

    if (transferProgress) {
      wrappedRemoteCallbacks.transferProgress = createCallbackWrapper(
        transferProgress,
        remote
      );
    }

    wrappedFetchOptions.callbacks = wrappedRemoteCallbacks;

    await this.fetch(remote, wrappedFetchOptions);
  }
};

/**
 * @async
 * @param {FetchheadForeachCb} callback The callback function to be called on
 * each entry
 */
Repository.prototype.fetchheadForeach = function (callback) {
  return _fetchheadForeach.call(this, callback, null);
};

/**
 * Retrieve the blob represented by the oid.
 *
 * @async
 * @param {String|Oid} String sha or Oid
 * @return {Blob}
 */
Repository.prototype.getBlob = async function (oid) {
  var blob = await Blob.lookup(this, oid);
  blob.repo = this;
  return blob;
};

/**
 * Look up a branch. Alias for `getReference`
 *
 * @async
 * @param {String|Reference} name Ref name, e.g. "master", "refs/heads/master"
 *                              or Branch Ref
 * @return {Reference}
 */
Repository.prototype.getBranch = function (name) {
  return this.getReference(name);
};

/**
 * Look up a branch's most recent commit. Alias to `getReferenceCommit`
 *
 * @async
 * @param {String|Reference} name Ref name, e.g. "master", "refs/heads/master"
 *                          or Branch Ref
 * @return {Commit}
 */
Repository.prototype.getBranchCommit = async function (name) {
  return await this.getReferenceCommit(name);
};

/**
 * Retrieve the commit identified by oid.
 *
 * @async
 * @param {String|Oid} String sha or Oid
 * @return {Commit}
 */
Repository.prototype.getCommit = function (oid) {
  var repository = this;

  return Commit.lookup(repository, oid);
};

/**
 * Gets the branch that HEAD currently points to
 * Is an alias to head()
 *
 * @async
 * @return {Reference}
 */
Repository.prototype.getCurrentBranch = function () {
  return this.head();
};

/**
 * Retrieve the commit that HEAD is currently pointing to
 *
 * @async
 * @return {Commit}
 */
Repository.prototype.getHeadCommit = async function () {
  try {
    const head = await Reference.nameToId(this, "HEAD");
    return await this.getCommit(head);
  } catch (_) {
    return null;
  }
};

/**
 * Retrieve the master branch commit.
 *
 * @async
 * @return {Commit}
 */
Repository.prototype.getMasterCommit = function () {
  return this.getBranchCommit("master");
};

/**
 * Lookup the reference with the given name.
 *
 * @async
 * @param {String|Reference} name Ref name, e.g. "master", "refs/heads/master"
 *                               or Branch Ref
 * @return {Reference}
 */
Repository.prototype.getReference = async function (name) {
  var reference = await Reference.dwim(this, name);
  if (reference.isSymbolic()) {
    var ref2 = await reference.resolve();
    ref2.repo = this;
    return ref2;
  } else {
    reference.repo = this;
    return reference;
  }
};

/**
 * Look up a refs's commit.
 *
 * @async
 * @param {String|Reference} name Ref name, e.g. "master", "refs/heads/master"
 *                              or Branch Ref
 * @return {Commit}
 */
Repository.prototype.getReferenceCommit = async function (name) {
  const reference = await this.getReference(name);
  return await this.getCommit(reference.target());
};

/**
 * Lookup reference names for a repository.
 *
 * @async
 * @param {Reference.TYPE} type Type of reference to look up
 * @return {Array<String>}
 */
Repository.prototype.getReferenceNames = function (type) {
  return Repository.getReferences(this, type, true);
};

/**
 * Lookup references for a repository.
 *
 * @async
 * @param {Reference.TYPE} type Type of reference to look up
 * @return {Array<Reference>}
 */

/**
 * Gets a remote from the repo
 *
 * @async
 * @param {String|Remote} remote
 * @return {Remote} The remote object
 */
Repository.prototype.getRemote = function (remote) {
  if (remote instanceof NodeGit.Remote) {
    return Promise.resolve(remote);
  }

  return NodeGit.Remote.lookup(this, remote);
};

/**
 * Lists out the remotes in the given repository.
 *
 * @async
 * @return {Object} Promise object.
 */
Repository.prototype.getRemoteNames = function () {
  return Remote.list(this);
};

/**
 * Get the status of a repo to it's working directory
 *
 * @async
 * @param {obj} opts
 * @return {Array<StatusFile>}
 */
Repository.prototype.getStatus = async function (opts) {
  var statuses = [];
  const statusCallback = function (path, status) {
    statuses.push(new StatusFile({ path: path, status: status }));
  };

  if (!opts) {
    opts = {
      flags: Status.OPT.INCLUDE_UNTRACKED | Status.OPT.RECURSE_UNTRACKED_DIRS,
    };
  }

  await Status.foreachExt(this, opts, statusCallback);
  return statuses;
};

/**
 * Get extended statuses of a repo to it's working directory. Status entries
 * have `status`, `headToIndex` delta, and `indexToWorkdir` deltas
 *
 * @async
 * @param {obj} opts
 * @return {Array<StatusFile>}
 */
Repository.prototype.getStatusExt = async function (opts) {
  if (!opts) {
    opts = {
      flags:
        Status.OPT.INCLUDE_UNTRACKED |
        Status.OPT.RECURSE_UNTRACKED_DIRS |
        Status.OPT.RENAMES_INDEX_TO_WORKDIR |
        Status.OPT.RENAMES_HEAD_TO_INDEX |
        Status.OPT.RENAMES_FROM_REWRITES,
    };
  }

  const list = await StatusList.create(this, opts);
  var statuses = [];
  for (var i = 0; i < list.entrycount(); i++) {
    const entry = Status.byIndex(list, i);
    statuses.push(new StatusFile({ entry: entry }));
  }
  return statuses;
};

/**
 * Get the names of the submodules in the repository.
 *
 * @async
 * @return {Array<String>}
 */
Repository.prototype.getSubmoduleNames = async function () {
  var names = [];
  const submoduleCallback = function (submodule, name, payload) {
    names.push(name);
  };

  await Submodule.foreach(this, submoduleCallback);
  return names;
};

/**
 * Retrieve the tag represented by the oid.
 *
 * @async
 * @param {String|Oid} String sha or Oid
 * @return {Tag}
 */
Repository.prototype.getTag = async function (oid) {
  var reference = await Tag.lookup(this, oid);
  reference.repo = this;
  return reference;
};

/**
 * Retrieve the tag represented by the tag name.
 *
 * @async
 * @param {String} Short or full tag name
 * @return {Tag}
 */
Repository.prototype.getTagByName = async function (name) {
  name = ~name.indexOf("refs/tags/") ? name : "refs/tags/" + name;
  const oid = await Reference.nameToId(this, name);
  var reference = await Tag.lookup(this, oid);
  reference.repo = this;
  return reference;
};

/**
 * Retrieve the tree represented by the oid.
 *
 * @async
 * @param {String|Oid} String sha or Oid
 * @return {Tree}
 */
Repository.prototype.getTree = async function (oid) {
  var tree = await Tree.lookup(this, oid);
  tree.repo = this;
  return tree;
};

/**
 * Returns true if the repository is in the APPLY_MAILBOX or
 * APPLY_MAILBOX_OR_REBASE state.
 * @return {Boolean}
 */
Repository.prototype.isApplyingMailbox = function () {
  const state = this.state();
  return (
    state === NodeGit.Repository.STATE.APPLY_MAILBOX ||
    state === NodeGit.Repository.STATE.APPLY_MAILBOX_OR_REBASE
  );
};

/**
 * Returns true if the repository is in the BISECT state.
 * @return {Boolean}
 */
Repository.prototype.isBisecting = function () {
  return this.state() === NodeGit.Repository.STATE.BISECT;
};

/**
 * Returns true if the repository is in the CHERRYPICK state.
 * @return {Boolean}
 */
Repository.prototype.isCherrypicking = function () {
  return this.state() === NodeGit.Repository.STATE.CHERRYPICK;
};

/**
 * Returns true if the repository is in the default NONE state.
 * @return {Boolean}
 */
Repository.prototype.isDefaultState = function () {
  return this.state() === NodeGit.Repository.STATE.NONE;
};

/**
 * Returns true if the repository is in the MERGE state.
 * @return {Boolean}
 */
Repository.prototype.isMerging = function () {
  return this.state() === NodeGit.Repository.STATE.MERGE;
};

/**
 * Returns true if the repository is in the REBASE, REBASE_INTERACTIVE, or
 * REBASE_MERGE state.
 * @return {Boolean}
 */
Repository.prototype.isRebasing = function () {
  var state = this.state();
  return (
    state === NodeGit.Repository.STATE.REBASE ||
    state === NodeGit.Repository.STATE.REBASE_INTERACTIVE ||
    state === NodeGit.Repository.STATE.REBASE_MERGE
  );
};

/**
 * Returns true if the repository is in the REVERT state.
 * @return {Boolean}
 */
Repository.prototype.isReverting = function () {
  return this.state() === NodeGit.Repository.STATE.REVERT;
};

/**
 * Rebases a branch onto another branch
 *
 * @async
 * @param {String}     branch
 * @param {String}     upstream
 * @param {String}     onto
 * @param {Signature}  signature     Identity of the one performing the rebase
 * @param {Function}   beforeNextFn  Callback to be called before each step
 *                                   of the rebase.  If the callback returns a
 *                                   promise, the rebase will resume when the
 *                                   promise resolves.  The rebase object is
 *                                   is passed to the callback.
 * @param {Function}   beforeFinishFn Callback called before the invocation
 *                                    of finish(). If the callback returns a
 *                                    promise, finish() will be called when the
 *                                    promise resolves. This callback will be
 *                                    provided a detailed overview of the rebase
 * @param {RebaseOptions} rebaseOptions Options to initialize the rebase object
 *                                      with
 * @return {Oid|Index}  A commit id for a succesful merge or an index for a
 *                      rebase with conflicts
 */
Repository.prototype.rebaseBranches = async function (
  branch,
  upstream,
  onto,
  signature,
  beforeNextFn,
  beforeFinishFn,
  rebaseOptions
) {
  let mergeOptions = (rebaseOptions || {}).mergeOptions;

  if (!signature) {
    signature = await this.defaultSignature();
  }

  const refs = await Promise.all([
    this.getReference(branch),
    upstream ? this.getReference(upstream) : null,
    onto ? this.getReference(onto) : null,
  ]);
  const [branchCommit, upstreamCommit, ontoCommit] = await Promise.all([
    NodeGit.AnnotatedCommit.fromRef(this, refs[0]),
    upstream ? NodeGit.AnnotatedCommit.fromRef(this, refs[1]) : null,
    onto ? NodeGit.AnnotatedCommit.fromRef(this, refs[2]) : null,
  ]);
  const oid = await NodeGit.Merge.base(
    this,
    branchCommit.id(),
    upstreamCommit.id()
  );

  if (oid.toString() === branchCommit.id().toString()) {
    // we just need to fast-forward
    await this.mergeBranches(branch, upstream, null, null, mergeOptions);
    // checkout 'branch' to match the behavior of rebase
    await this.checkoutBranch(branch);
  } else if (oid.toString() === upstreamCommit.id().toString()) {
    // 'branch' is already on top of 'upstream'
    // checkout 'branch' to match the behavior of rebase
    await this.checkoutBranch(branch);
  } else {
    const rebase = await NodeGit.Rebase.init(
      this,
      branchCommit,
      upstreamCommit,
      ontoCommit,
      rebaseOptions
    );
    const error = await performRebase(
      this,
      rebase,
      signature,
      beforeNextFn,
      beforeFinishFn
    );
    if (error) {
      throw error;
    }
  }

  return await this.getBranchCommit("HEAD");
};

/**
 * Grabs a fresh copy of the index from the repository. Invalidates
 * all previously grabbed indexes
 *
 * @async
 * @return {Index}
 */
Repository.prototype.refreshIndex = function () {
  var repo = this;

  repo.setIndex(); // clear the index

  return repo.index();
};

/**
 * Merge a branch onto another branch
 *
 * @async
 * @param {String|Reference}        to
 * @param {String|Reference}        from
 * @param {Signature}         signature
 * @param {Merge.PREFERENCE}  mergePreference
 * @param {MergeOptions}      mergeOptions
 * @param {MergeBranchOptions} mergeBranchOptions
 * @return {Oid|Index}  A commit id for a succesful merge or an index for a
 *                      merge with conflicts
 */
Repository.prototype.mergeBranches = async function (
  to,
  from,
  signature,
  mergePreference,
  mergeOptions,
  mergeBranchOptions
) {
  // Support old parameter `processMergeMessageCallback`
  const isOldOptionParameter = typeof mergeBranchOptions === "function";
  if (isOldOptionParameter) {
    console.error(
      "DeprecationWarning: Repository#mergeBranches parameter " +
        "processMergeMessageCallback, use MergeBranchOptions"
    );
  }
  const processMergeMessageCallback =
    (mergeBranchOptions &&
      (isOldOptionParameter
        ? mergeBranchOptions
        : mergeBranchOptions.processMergeMessageCallback)) ||
    function (message) {
      return message;
    };
  const signingCallback = mergeBranchOptions && mergeBranchOptions.signingCb;

  mergePreference = mergePreference || NodeGit.Merge.PREFERENCE.NONE;

  if (!signature) {
    signature = await this.defaultSignature();
  }

  const [toBranch, fromBranch] = await Promise.all([
    this.getBranch(to),
    this.getBranch(from),
  ]);
  const branchCommits = await Promise.all([
    this.getBranchCommit(toBranch),
    this.getBranchCommit(fromBranch),
  ]);
  const toCommitOid = branchCommits[0].toString();
  const fromCommitOid = branchCommits[1].toString();

  const baseCommit = await NodeGit.Merge.base(this, toCommitOid, fromCommitOid);

  if (baseCommit.toString() == fromCommitOid) {
    // The commit we're merging to is already in our history.
    // nothing to do so just return the commit the branch is on
    return toCommitOid;
  } else if (
    baseCommit.toString() == toCommitOid &&
    mergePreference !== NodeGit.Merge.PREFERENCE.NO_FASTFORWARD
  ) {
    // fast forward
    const message =
      "Fast forward branch " +
      toBranch.shorthand() +
      " to branch " +
      fromBranch.shorthand();

    const tree = await branchCommits[1].getTree();
    if (toBranch.isHead()) {
      // Checkout the tree if we're on the branch
      const opts = {
        checkoutStrategy:
          NodeGit.Checkout.STRATEGY.SAFE |
          NodeGit.Checkout.STRATEGY.RECREATE_MISSING,
      };
      await NodeGit.Checkout.tree(this, tree, opts);
    }
    await toBranch.setTarget(fromCommitOid, message);
    return fromCommitOid;
  } else if (mergePreference !== NodeGit.Merge.PREFERENCE.FASTFORWARD_ONLY) {
    // We have to merge. Lets do it!
    const headRef_ = await NodeGit.Reference.lookup(this, "HEAD");
    const headRef = await headRef_.resolve();
    const updateHead = !!headRef && headRef.name() === toBranch.name();
    const index = await NodeGit.Merge.commits(
      this,
      toCommitOid,
      fromCommitOid,
      mergeOptions
    );
    // if we have conflicts then throw the index
    if (index.hasConflicts()) {
      throw index;
    }

    // No conflicts so just go ahead with the merge
    const oid_ = await index.writeTreeTo(this);
    var mergeDecorator;
    if (fromBranch.isTag()) {
      mergeDecorator = "tag";
    } else if (fromBranch.isRemote()) {
      mergeDecorator = "remote-tracking branch";
    } else {
      mergeDecorator = "branch";
    }

    var message_ =
      "Merge " + mergeDecorator + " '" + fromBranch.shorthand() + "'";

    // https://github.com/git/git/blob/master/builtin/fmt-merge-msg.c#L456-L459
    if (toBranch.shorthand() !== "master") {
      message_ += " into " + toBranch.shorthand();
    }

    const [oid, message] = await Promise.all([
      oid_,
      processMergeMessageCallback(message_),
    ]);

    const commit = signingCallback
      ? await this.createCommitWithSignature(
          toBranch.name(),
          signature,
          signature,
          message,
          oid,
          [toCommitOid, fromCommitOid],
          signingCallback
        )
      : await this.createCommit(
          toBranch.name(),
          signature,
          signature,
          message,
          oid,
          [toCommitOid, fromCommitOid]
        );
    // we've updated the checked out branch, so make sure we update
    // head so that our index isn't messed up
    if (updateHead) {
      const branch = await this.getBranch(to);
      const branchCommit = await this.getBranchCommit(branch);
      const tree = await branchCommit.getTree();
      const opts = {
        checkoutStrategy:
          NodeGit.Checkout.STRATEGY.SAFE |
          NodeGit.Checkout.STRATEGY.RECREATE_MISSING,
      };
      await NodeGit.Checkout.tree(this, tree, opts);
    }
    return commit;
  } else {
    // A non fast-forwardable merge with ff-only
    return toCommitOid;
  }
};

/**
 * @async
 * @param {MergeheadForeachCb} callback The callback function to be called on
 * each entry
 */
Repository.prototype.mergeheadForeach = function (callback) {
  return _mergeheadForeach.call(this, callback, null);
};

/**
 * Stages or unstages line selection of a specified file
 *
 * @async
 * @param {String|Array} filePath The relative path of this file in the repo
 * @param {Boolean} stageNew Set to stage new filemode. Unset to unstage.
 * @return {Number} 0 or an error code
 */
Repository.prototype.stageFilemode = async function (
  filePath,
  stageNew,
  additionalDiffOptions
) {
  var repo = this;
  var index;
  var diffOptions = additionalDiffOptions
    ? { flags: additionalDiffOptions }
    : undefined;
  var diffPromise = stageNew
    ? NodeGit.Diff.indexToWorkdir(repo, index, {
        flags:
          NodeGit.Diff.OPTION.SHOW_UNTRACKED_CONTENT |
          NodeGit.Diff.OPTION.RECURSE_UNTRACKED_DIRS |
          (additionalDiffOptions || 0),
      })
    : repo
        .getHeadCommit()
        .then((commit) => commit.getTree())
        .then((tree) =>
          NodeGit.Diff.treeToIndex(repo, tree, index, diffOptions)
        );
  var filePaths = filePath instanceof Array ? filePath : [filePath];

  var indexLock = repo.path().replace(".git/", "") + ".git/index.lock";

  await fse.remove(indexLock);
  index = await repo.refreshIndex();
  const diff = await diffPromise;
  var origLength = filePaths.length;

  const results = await Promise.all(
    fp.map(
      (p) =>
        NodeGit.Status.file(repo, p).then((status) => ({
          path: p,
          filter:
            status & NodeGit.Status.STATUS.WT_MODIFIED ||
            status & NodeGit.Status.STATUS.INDEX_MODIFIED,
        })),
      filePaths
    )
  );

  filePaths = fp.flow([
    fp.filter((filterResult) => filterResult.filter),
    fp.map((filterResult) => filterResult.path),
  ])(results);

  if (filePaths.length === 0 && origLength > 0) {
    throw new Error("Selected staging is only available on modified files.");
  }
  const patches = await diff.patches();
  const pathPatches = patches.filter(
    (patch) => ~filePaths.indexOf(patch.newFile().path())
  );
  if (pathPatches.length === 0) {
    throw new Error("No differences found for this file.");
  }

  await Promise.all(
    pathPatches.map(async (pathPatch) => {
      var entry = index.getByPath(pathPatch.newFile().path(), 0);

      entry.mode = stageNew
        ? pathPatch.newFile().mode()
        : pathPatch.oldFile().mode();

      await index.add(entry);
    })
  );

  return await index.write();
};

/**
 * Stages or unstages line selection of a specified file
 *
 * @async
 * @param {String} filePath The relative path of this file in the repo
 * @param {Array} selectedLines The array of DiffLine objects
 *                            selected for staging or unstaging
 * @param {Boolean} isStaged Are the selected lines currently staged
 * @return {Number} 0 or an error code
 */
Repository.prototype.stageLines = async function (
  filePath,
  selectedLines,
  isSelectionStaged,
  additionalDiffOptions
) {
  const index = await this.refreshIndex();

  // The following chain checks if there is a patch with no hunks left for the
  // file, and no filemode changes were done on the file. It is then safe to
  // stage the entire file so the file doesn't show as having unstaged changes
  // in `git status`. Also, check if there are no type changes.
  const lastHunkStagedPromise = async () => {
    const diff = await NodeGit.Diff.indexToWorkdir(this, index, {
      flags:
        NodeGit.Diff.OPTION.SHOW_UNTRACKED_CONTENT |
        NodeGit.Diff.OPTION.RECURSE_UNTRACKED_DIRS |
        (additionalDiffOptions || 0),
    });

    const patches = await diff.patches();

    const pathPatch = patches.filter(
      (patch) => patch.newFile().path() === filePath
    );
    var emptyPatch = false;
    if (pathPatch.length > 0) {
      // No hunks, unchanged file mode, and no type changes.
      emptyPatch =
        pathPatch[0].size() === 0 &&
        pathPatch[0].oldFile().mode() === pathPatch[0].newFile().mode() &&
        !pathPatch[0].isTypeChange();
    }
    if (emptyPatch) {
      await index.addByPath(filePath);
      return await index.write();
    }
  };

  const pathOid = index.getByPath(filePath).id;
  const originalBlob = await this.getBlob(pathOid);
  const hunks = await getPathHunks(
    this,
    index,
    filePath,
    isSelectionStaged,
    additionalDiffOptions
  );
  const newContent = await applySelectedLinesToTarget(
    originalBlob,
    selectedLines,
    hunks,
    isSelectionStaged
  );
  const newOid = await this.createBlobFromBuffer(Buffer.from(newContent));
  const newBlob = await this.getBlob(newOid);

  var entry = index.getByPath(filePath, 0);
  entry.id = newBlob.id();
  entry.path = filePath;
  entry.fileSize = newBlob.content().length;

  await index.add(entry);

  const result = await index.write();
  if (!isSelectionStaged) {
    await lastHunkStagedPromise();
  }
  return result;
};

/**
 * Create a new tree builder.
 *
 * @param {Tree} tree
 */
Repository.prototype.treeBuilder = function () {
  var builder = TreeBuilder.create(null);

  builder.root = builder;
  builder.repo = this;

  return builder;
};
