/* Imports */
const core = require('@actions/core');
const github = require('@actions/github');

/* Default Result Output */
core.setOutput('updated', false);

/* Global Constants */
const payload = github.context.payload // Full event payload
console.log(`Event Payload:\n${JSON.stringify(payload, undefined, 2)}`);
const client = github.getOctokit(core.getInput('repo-token')); // Get token and create Github client
const repoName = payload.repository.name; // Reposistory the event occured in
const orgName = payload.repository.owner.login; // Organization that owns the repository
const newColumnID = payload.project_card.column_id; // The ID of the card's new column
const oldColumnID = payload.changes.column_id.from; // The ID of the card's old column
const userName = payload.sender.login; // User who triggered the event
const splitCardURL = payload.project_card.content_url.split('/');
const issueNum = splitCardURL[splitCardURL.length - 1]; // Get the card's issue number
const projectName = 'Ops/Eng CFT Production Board'
const columns = { // Column transition configuration object
  'Service/Inspection Required (Prod)': {
    'assignees': ['jditchen'],
    'labels_to_add': ['Rework Required'],
    'labels_to_remove': [],
  },
  'Service/Inspection Complete (HW/QE)': {
    'assignees': ['blang-Fetch', 'JeffWilson7'],
    'labels_to_add': [],
    'labels_to_remove': ['Rework Required'],
  },
  'Hardware Team Required (HW)': {
    'assignees': ['blang-Fetch'],
    'labels_to_add': ['HW Team'],
    'labels_to_remove': ['QE Team'],
  },
  'QE Team Required (QE)': {
    'assignees': ['JeffWilson7'],
    'labels_to_add': ['QE Team'],
    'labels_to_remove': ['HW Team'],
  },
  'Ready to Ship (Prod)': {
    'assignees': ['jditchen'],
    'labels_to_add': [],
    'labels_to_remove': ['HW Team', 'QE Team'],
  },
}

/* Helper to get a column name from ID */
async function getColumnName(columnID) {
  const column = await client.rest.projects.getColumn({column_id: columnID});
  return column.data.name;
}

/* Helper to validate user specified labels */
async function validateLabels(labels) {
  let repoLabels = await client.rest.issues.listLabelsForRepo({
    owner: orgName,
    repo: repoName
  });
  let validLabels = repoLabels.data.map(l => l.name);
  for (let l of labels)
    if (!validLabels.includes(l))
      throw new Error(`Invalid label name: ${l}`);
}

/* Main */
(async () => {
  try {
    // Only continue if the project matches what's specified in this file.
    const eventProject = await client.request("GET " + payload.project_card.project_url);
    const eventProjectName = eventProject.data.name;
    if (projectName != eventProjectName) {
      console.log(`Card was moved to a column in project "${eventProjectName}" not ` +
                  `"${projectName}".\n Nothing to do.`);
      return;
    }
    
    // Get the name of the card's old column
    const oldColumnName = await getColumnName(oldColumnID);
    console.log("Old Column: " + oldColumnName);

    // Lookup the column name in the configuration object
    const newColumnName = await getColumnName(newColumnID);
    console.log("New Column: " + newColumnName);
    if (!(newColumnName in columns)) {
      console.log(`No actions to take for column "${newColumnName}"`);
      return;
    }
    
    // Validate labels
    const labelsToAdd = columns[newColumnName].labels_to_add;
    const labelsToRemove = columns[newColumnName].labels_to_remove;
    await validateLabels(labelsToAdd);
    await validateLabels(labelsToRemove);
    let duplicatedLabels = [];
    for (let l of labelsToAdd)
      if (labelsToRemove.includes(l))
        duplicatedLabels.push(l);
    if (duplicatedLabels.length)
      throw new Error(`Duplicated label(s) in add and remove lists: ${duplicatedLabels}`);

    // Build list of labels to set
    const currentLabels = await client.rest.issues.listLabelsOnIssue({
      owner: orgName,
      repo: repoName,
      issue_number: issueNum,
    });
    const currentLabelNames = currentLabels.data.map(l => l.name);
    let labelsToSet = new Set(labelsToAdd);
    for (let l of currentLabelNames)
      if (!labelsToRemove.includes(l))
        labelsToSet.add(l);

    // Validate the default assignees have access to the repository, throws a 404 exception on failure
    const assigneeUserNames = columns[newColumnName].assignees;
    for (let a of assigneeUserNames) {
      await client.rest.issues.checkUserCanBeAssigned({
        owner: orgName,
        repo: repoName,
        assignee: a
      });
    }

    // Update the issue
    await client.rest.issues.update({
      owner: orgName,
      repo: repoName,
      issue_number: issueNum,
      labels: [...labelsToSet],
      assignees: assigneeUserNames
    });
    core.setOutput('updated', true);
  } catch (error) {
    core.setFailed();
    console.log(error);
  }
})();
