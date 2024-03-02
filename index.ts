import "dotenv/config";
import axios from "axios";
import AdmZip from "adm-zip";
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";

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
    console.log(`task.state: ${task.state}`);
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

/*
Extract files from ZIP file to destination (workspaceDir) from filename (workspaceZip)
*/
const extractZip = async (
  filename: string,
  destination: string
): Promise<void> => {
  // Initialize AdmZip with the downloaded zip file.
  const zip = new AdmZip(filename);
  // Extract the entire contents of the zip file to the specified destination directory.
  zip.extractAllTo(destination, true);

  // Retrieve the names of all files extracted from the zip.
  const extractedFiles = zip.getEntries().map((entry) => entry.entryName);
  console.log(`extractedFiles: ${extractedFiles}\n\n\n`);
  // Filter for any files named like "Part-*.zip", indicating split zip files.
  const partFiles = extractedFiles.filter((name) =>
    name.match(/Part-\d+\.zip/)
  );
  console.log(`partFiles: ${partFiles}\n\n\n`);

  // Extract found "Part-*.zip" files to destination and delete them:
  await Promise.all(
    partFiles.map(async (partFile: string) => {  // loop over partFiles
      partFile = join(destination, partFile);  // move split "part" zip file into destination (workspaceDir)
      const partZip = new AdmZip(partFile);    
      partZip.extractAllTo(destination, true);  // extract split zip file ("part") into destination (workspaceDir)
      await fs.unlink(partFile);
    })
  );

  // Scan the destination directory for any folders starting with "Export-".
  const extractedFolders = await fs.readdir(destination);
  const exportFolders = extractedFolders.filter((name: string) =>
    name.startsWith("Export-")
  );

  // Move the contents of found "Export-*" folders to the destination and delete them:
  await Promise.all(
    exportFolders.map(async (folderName: string) => {
      const folderPath = join(destination, folderName);
      const contents = await fs.readdir(folderPath);
      await Promise.all(
        contents.map(async (file: string) => {
          const filePath = join(folderPath, file);
          const newFilePath = join(destination, file);
          await fs.rename(filePath, newFilePath);
        })
      );
      await fs.rmdir(folderPath);
    })
  );
};

// 
const run = async (): Promise<void> => {
  const workspaceDir = join(process.cwd(), "workspace");      // create workspace dir for export work
  const workspaceZip = join(process.cwd(), "workspace.zip");  // create workspace.zip

  // init exportFromNotion with workspaceZip as the destination in markdown format
  await exportFromNotion(workspaceZip, "markdown");
  await fs.rm(workspaceDir, { recursive: true, force: true });  // remove old or existing workspace directory
  await fs.mkdir(workspaceDir, { recursive: true });            // create workspace directory
  await extractZip(workspaceZip, workspaceDir);                 // extract zip file to workspace directory
  await fs.unlink(workspaceZip);    // close fs link for file

  console.log("✅ Export downloaded and unzipped.");
};

run();
