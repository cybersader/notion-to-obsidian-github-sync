import "dotenv/config";
import axios from "axios";
import AdmZip from "adm-zip";
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";

// FUNCTIONS FOR OBSIDIAN-RELATED PROCESSING

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

const adjustFilenames = async (dir, prefix = '', skipDirName = '', filenameChanges = {}) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let fileCounter = 1;

  for (const entry of entries) {
    if (entry.name === skipDirName) continue; // Skip processing for specified directory name
    
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into subdirectories, carrying filenameChanges along
      await adjustFilenames(fullPath, `${prefix}${fileCounter.toString().padStart(2, '0')}-`, skipDirName, filenameChanges);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Process markdown files: remove page ID, prepend numbering
      const originalName = entry.name;
      console.log(`${originalName}`)
      const newName = `${prefix}${fileCounter.toString().padStart(2, '0')}-${entry.name.replace(/\s\w{32}\.md$/, '.md')}`;
      await fs.rename(fullPath, join(dir, newName));
      filenameChanges[join(dir, originalName)] = join(dir, newName); // Track the change
    }
    fileCounter++;
  }

  return filenameChanges;
};

const updateInternalLinks = async (dir, mappings) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      await updateInternalLinks(fullPath, mappings);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      let content = await fs.readFile(fullPath, 'utf8');
      // Replace old paths with new paths in markdown content
      for (const [oldPath, newPath] of Object.entries(mappings)) {
        // You'll need a more sophisticated replace logic to match markdown link syntax
        content = content.replace(new RegExp(oldPath, 'g'), newPath);
      }
      await fs.writeFile(fullPath, content, 'utf8');
    }
  }
};
// ---------------------------------------------------------------------------------

// Class for tracking Notion export progress and status
type NotionTask = {
  id: string;
  state: string;
  status: {
    pagesExported: number;
    exportURL: string;
  };
  error?: string;
};

// Obtain GitHub Environment Variables
const { NOTION_TOKEN, NOTION_SPACE_ID, NOTION_USER_ID } = process.env;
if (!NOTION_TOKEN || !NOTION_SPACE_ID || !NOTION_USER_ID) {
  throw new Error(
    "Environment variable NOTION_TOKEN, NOTION_SPACE_ID or NOTION_USER_ID is missing. Check the README.md for more information."
  );
}

/*
Notion API Request Setup
Sets up: URL, NOTION_TOKEN, NOTION_USER_ID
*/
const client = axios.create({
  baseURL: "https://www.notion.so/api/v3", // Unofficial Notion API
  headers: {
    Cookie: `token_v2=${NOTION_TOKEN};`,
    "x-notion-active-user-header": NOTION_USER_ID,
  },
});

/*
Set timeout for asynchronous requests
*/
const sleep = async (seconds: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

const round = (number: number) => Math.round(number * 100) / 100;

/*
Request and obtain pages into ZIP file
1. Send "enqueueTask" to setup exporting from Notion workspace
2. 
*/
const exportFromNotion = async (
  destination: string,
  format: string
): Promise<void> => {
  // Initial request to Notion API to start the export process
  const task = {  // set up request details
    eventName: "exportSpace",
    request: {
      spaceId: NOTION_SPACE_ID,
      shouldExportComments: false,
      exportOptions: {
        exportType: format,
        collectionViewExportType: "currentView",
        timeZone: "Europe/Berlin",
        locale: "en",
        preferredViewMap: {},
      },
    },
  };
  const {
    data: { taskId },
  }: { data: { taskId: string } } = await client.post("enqueueTask", { task }); //Send enqueueTask in POST
                                                                                //request and obtain returned 
                                                                                //taskId

  // Log export taskId generated from enqueueTask request for Notion API
  console.log(`Started export as task [${taskId}].`);

  
  let exportURL: string;                        //variable for storing URL to grab files from during request loop
  let fileTokenCookie: string | undefined;      //variable for storing token for grabbing files during request loop

  /*
  Loop to check the export task status as file export tasks are queued for Notion API
  */
  while (true) {
    await sleep(2);
    const {
      data: { results: tasks },
      headers: { "set-cookie": getTasksRequestCookies }, // ??????
    }: {
      data: { results: NotionTask[] };
      headers: { [key: string]: string[] }; 
    } = await client.post("getTasks", { taskIds: [taskId] });  // obtain task Ids as responses come back
    const task = tasks.find((t) => t.id === taskId); // ????

    if (!task) throw new Error(`Task [${taskId}] not found.`);
    if (task.error) throw new Error(`Export failed with reason: ${task.error}`);

    console.log(`Exported ${task.status.pagesExported} pages.`);

    /*
      once all tasks have finished -> task.state==="success", then grab file export URL and token
    */
    // console.log(`task.state: ${task.state}`); // Log state for testing
    if (task.state === "success") {
      exportURL = task.status.exportURL;
      fileTokenCookie = getTasksRequestCookies.find((cookie) =>
        cookie.includes("file_token=")
      );
      if (!fileTokenCookie) {
        throw new Error("Task finished but file_token cookie not found.");
      }
      console.log(`Export finished.`);
      break;
    }
  }

  // Create GET request for Notion workspace ZIP file download - based on above URL and token
  const response = await client({
    method: "GET",
    url: exportURL,
    responseType: "stream",
    headers: { Cookie: fileTokenCookie },
  });

  // Log the download size information for the ZIP file
  const size = response.headers["content-length"];
  console.log(`Downloading ${round(size / 1000 / 1000)}mb...`);
  
  // createWriteStream - https://www.geeksforgeeks.org/node-js-fs-createwritestream-method/
  // Use axios client variable to stream the response of the exported file from Notion's export URL with
  // fs.createWriteStream()
  const stream = response.data.pipe(createWriteStream(destination)); //destination is workspaceZip - write to zip file
  // Wait for the file to be fully written to the destination.
  await new Promise((resolve, reject) => {
    // Resolve the promise when the stream is closed, indicating the file has been written.
    stream.on("close", resolve);
    // Reject the promise on any errors during the write process.
    stream.on("error", reject);
  });
};

// Extract files from ZIP file to destination (workspaceDir) from filename (workspaceZip)
const extractZip = async (
  filename: string,
  destination: string
): Promise<void> => {
  // Initialize AdmZip with the downloaded zip file.
  const zip = new AdmZip(filename);
  
  // Extract the entire contents of the zip file to the specified destination directory.
  // The `true` argument specifies to overwrite files if they already exist.
  zip.extractAllTo(destination, true);

  // Retrieve a list of all entries (files and directories) within the zip file.
  // This is used to identify specific files that need special handling (like "Part-*.zip" files).
  const extractedFiles = zip.getEntries().map((entry) => entry.entryName);
  
  console.log(`extractedFiles: ${extractedFiles}\n\n\n`);

  // Notion's export process can split large exports into multiple zip files.
  // These are identified by a "Part-*.zip" naming convention.
  // Here, we filter out these split zip file names for further processing.
  const partFiles = extractedFiles.filter((name) =>
    name.match(/Part-\d+\.zip/)
  );
  console.log(`partFiles: ${partFiles}\n\n\n`);

  // Extract found "Part-*.zip" files to destination and delete them:
  await Promise.all(
    partFiles.map(async (partFile: string) => {  // loop over partFiles
      // Use the `join` function to construct the full path to the "Part-*.zip" file within the destination directory.
      // This is necessary because the `partFile` variable only contains the filename, not the full path.
      partFile = join(destination, partFile);  // move split "part" zip file into destination (workspaceDir)

      // Initialize a new instance of AdmZip with the "Part-*.zip" file.
      // This allows us to extract its contents.
      const partZip = new AdmZip(partFile);

      // Extract the contents of the "Part-*.zip" file to the destination directory.
      partZip.extractAllTo(destination, true);  // extract split zip file ("part") into the destination (workspaceDir)

      // After extraction, delete the "Part-*.zip" file as it's no longer needed.
      // This helps clean up the destination directory.
      await fs.unlink(partFile);
    })
  );

  // After handling "Part-*.zip" files, scan the destination directory for folders prefixed with "Export-".
  // This prefix is used by Notion for directories containing exported content.
  const extractedFolders = await fs.readdir(destination);
  const exportFolders = extractedFolders.filter((name: string) =>
    name.startsWith("Export-")
  );

  // For each "Export-*" folder found, move its contents to the root of the destination directory.
  // This reorganization simplifies the structure of the extracted content.
  await Promise.all(
    exportFolders.map(async (folderName: string) => {

      // Construct the full path to the "Export-*" folder.
      const folderPath = join(destination, folderName);

      // Read the contents of the "Export-*" folder to get a list of files (and possibly subdirectories) it contains
      const contents = await fs.readdir(folderPath);

      // For each item in the "Export-*" folder, move it to the root of the destination directory.
      await Promise.all(
        contents.map(async (file: string) => {
          const filePath = join(folderPath, file);      // Full path to the item in the "Export-*" folder.
          const newFilePath = join(destination, file);  // New path for the item at the root of the destination directory.
          await fs.rename(filePath, newFilePath);       // Move the item.
        })
      );

      // Once all items have been moved out of the "Export-*" folder, delete the now-empty folder.
      await fs.rmdir(folderPath);
    })
  );
};

// 
const run = async (): Promise<void> => {
  let skipDirName = "Private & Shared"; // Define this globally or outside of your function
  let workspaceDir = join(process.cwd(), "workspace");      // create workspace dir for export work
  let workspaceZip = join(process.cwd(), "workspace.zip");  // create workspace.zip

  // init exportFromNotion with workspaceZip as the destination in markdown format
  await exportFromNotion(workspaceZip, "markdown");
  await fs.rm(workspaceDir, { recursive: true, force: true });  // remove old or existing workspace directory
  await fs.mkdir(workspaceDir, { recursive: true });            // create workspace directory
  await extractZip(workspaceZip, workspaceDir);                 // extract zip file to workspace directory

  // FUTURE TODOS:
  // TODO - option to fix long file names and paths for Windows issues ... ugh
  // TODO - option to automatically reformat markdown files in a certain way
  // TODO - option to prepend numbering or organizational string to the front of filename or directory
  // TODO - Obsidian community plugin code somehow integrated into the system?

  // Adjust filenames and capture the mapping of changes for updating internal links
  let filenameChanges = await adjustFilenames(workspaceDir);
  // Use filenameChanges to update internal markdown links
  await updateInternalLinks(workspaceDir, filenameChanges);
  
  await fs.unlink(workspaceZip);    // close fs link for file

  console.log("✅ Export downloaded and unzipped.");
};

run();
