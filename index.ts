import "dotenv/config";
import axios from "axios";
import AdmZip from "adm-zip";
import { createWriteStream, promises as fs, existsSync, Dirent } from "fs";
import { join, parse, basename, relative, extname } from "path";
import dotenv from 'dotenv';
import fse from 'fs-extra';
import { Client } from '@notionhq/client';
import { platform } from 'os';

// Configure dotenv to load the .env file
dotenv.config(); // Load environment variables from .env file 
let TEST_CODE_MODE = process.env.TEST_CODE_MODE; // Assumes testing for code
let TEST_NOTION_FILES = process.env.TEST_NOTION_FILES; // Assumes local testing with local notion export files
let TEST_GIT_MODE = process.env.TEST_GIT_MODE // Assumes local testing of git functionality

// FUNCTIONS FOR OBSIDIAN-RELATED PROCESSING

// print directory tree for testing
interface PrintDirTreeOptions {
  prefix?: string;
  level?: number;
  currentLevel?: number;
}

async function printDirTree(dir: string, options: PrintDirTreeOptions = {}): Promise<void> {
  const { prefix = '', level = Infinity, currentLevel = 0 } = options;

  if (currentLevel > level) {
      return;
  }

  const dirContents = await fs.readdir(dir, { withFileTypes: true });
  const sortedContents = dirContents.sort((a, b) => a.name.localeCompare(b.name));

  for (let i = 0; i < sortedContents.length; i++) {
      const dirent = sortedContents[i];
      const isLast = i === sortedContents.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const newPrefix = isLast ? prefix + '    ' : prefix + '│   ';

      console.log(prefix + connector + dirent.name);
      if (dirent.isDirectory()) {
          await printDirTree(join(dir, dirent.name), {
              prefix: newPrefix,
              level,
              currentLevel: currentLevel + 1,
          });
      }
  }
}

// Check if a path is absolute
// In Windows, an absolute path starts with a drive letter followed by ":\", in POSIX systems, it starts with "/"
const isAbsolutePath = (path: string): boolean => platform() === 'win32' ? /^[a-zA-Z]:\\/.test(path) : path.startsWith('/');

// Function to prepend the extended-length path prefix if on Windows and the path is not already extended
const toExtendedLengthPath = (path: string): string => {
    if (platform() === 'win32' && !path.startsWith('\\\\?\\')) {
        // If the path is not absolute, make it absolute by joining it with process.cwd()
        const absolutePath = isAbsolutePath(path) ? path : join(process.cwd(), path);
        return '\\\\?\\' + absolutePath;
    }
    return path;
};
// recursively count both directories and files and return total count for help with progress bar printing over dirs and files
const countItems = async (dir: string, skipDirName = '') => {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === skipDirName) continue; // Skip the specified directory
    count++; // Count this item
    if (entry.isDirectory()) {
      // Recursively count items in subdirectories
      count += await countItems(join(dir, entry.name), skipDirName);
    }
  }
  return count;
};

// escape inputted regular expression
function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// get Notion pages by manual menu order
const getNotionPages = async () => {

}

// Fix filenames to follow naming taxonomy/syntax useful for Obsidian
const adjustFilenames = async (
  dir: string = '',
  skipDirName: string = '',
  filenameChanges: Record<string, string> = {}, // Assuming filenameChanges is a map of string to string
  levelCount: { counts: number[]; currentLevel: number } = { counts: [0], currentLevel: 0 },
  namingSeparator: string = '_',
  parentPrefix: string = '',
  progressTracker: { processed: number; total: number; lastPrintedPercentage: number } | null = null,
  isRoot: boolean = true
) => {
  if (isRoot && !progressTracker) {
    const totalItems = await countItems(dir, skipDirName);
    console.log(`[x] [index.ts] [adjustFilenames] Total Items: ${totalItems}`)
    progressTracker = { processed: 0, total: totalItems, lastPrintedPercentage: -10 };
  }

  const entries = await fs.readdir(dir, { withFileTypes: true }).then(es => es.sort((a, b) => a.name.localeCompare(b.name)));

  for (const entry of entries) {
    if (entry.name === skipDirName) continue;
    
    const fullPath = join(dir, entry.name);

    // Ensure current level count is initialized
    if (levelCount.counts[levelCount.currentLevel] === undefined) {
      levelCount.counts[levelCount.currentLevel] = 0;
    }
    
    // Increment count for the current level
    levelCount.counts[levelCount.currentLevel]++;
    
    // Construct currentPrefix using the count for the current level
    let currentPrefix = `${parentPrefix}${levelCount.counts[levelCount.currentLevel].toString().padStart(2, '0')}${namingSeparator}`;
    
    if (entry.isDirectory()) {
      const newDirName = `${currentPrefix}${entry.name}`;
      const newDirPath = join(dir, newDirName);
      await fs.rename(fullPath, newDirPath); // Rename directory
      filenameChanges[fullPath] = newDirPath; // Track directory renaming
      
      // Recurse into directory with incremented currentLevel
      levelCount.currentLevel++;
      await adjustFilenames(newDirPath, skipDirName, filenameChanges, levelCount, namingSeparator, currentPrefix, progressTracker, false);
      levelCount.currentLevel--; // Decrement currentLevel after recursion
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const newFileName = `${currentPrefix}${entry.name.replace(/\s\w{32}\.md$/, '.md')}`;
      const newFilePath = join(dir, newFileName);
      await fs.rename(fullPath, newFilePath); // Rename file
      filenameChanges[fullPath] = newFilePath; // Track file renaming
      
      // Update and print progress
      if (progressTracker) {
        let progressPercentage = Math.round((progressTracker.processed*2 / progressTracker.total) * 100);
        if (progressPercentage >= progressTracker.lastPrintedPercentage + 10) {
          console.log(`[+] [index.ts] [adjustFilenames] Progress: ${progressTracker.processed*2}/${progressTracker.total} items processed (${progressPercentage}%)`);
          progressTracker.lastPrintedPercentage = progressPercentage;
        } else if (progressTracker.processed == progressTracker.total) {
          console.log(`[+] [index.ts] [adjustFilenames] Progress: ${progressTracker.processed*2}/${progressTracker.total} items processed (${progressPercentage}%)`);
        }
        progressTracker.processed++;
      }
    }
  }

  if (isRoot) {
    console.log("[+] [index.ts] [adjustFilenames] Filename adjustment complete.");
  }

  return filenameChanges;
};

interface RenameMapping {
  oldName: string;
  newName: string;
}

async function removePageIdsFromNames(dir: string, depth: number = 0, verbose: boolean = false): Promise<RenameMapping[]> {
  if (verbose) console.log(`Processing directory: ${dir} at depth: ${depth}`);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  let nameCounts: Record<string, number> = {};
  let oldToNewMappings: RenameMapping[] = [];
  let directoryMappings: { oldPath: string; newPath: string; }[] = [];

  for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const cleanedName = entry.name.replace(/^(.*?)(?:\s+([a-f0-9]{32}))?\s*(?:_(?:\w+))?\s*(\.[\w]{2,12})?$/, '$1$3');
      let newName = cleanedName;
      const pageId = entry.name.match(/\w{32}/)?.[0] || '';

      if (entry.isDirectory() || !oldToNewMappings.some(m => m.oldName === entry.name)) {
          if (nameCounts[cleanedName]) {
              nameCounts[cleanedName] += 1;
              const count = nameCounts[cleanedName];
              newName += ` _(${count})_`;
          } else {
              nameCounts[cleanedName] = 1;
          }

          const newFullPath = join(dir, newName);
          oldToNewMappings.push({ oldName: entry.name, newName: newName });

          if (entry.isDirectory()) {
              directoryMappings.push({ oldPath: fullPath, newPath: newFullPath });
          }
      }
  }

  // Perform renaming operations
  for (const { oldName, newName } of oldToNewMappings) {
      const oldFullPath = join(dir, oldName);
      const newFullPath = join(dir, newName);
      await fs.rename(oldFullPath, newFullPath);
      if (verbose) console.log(`Renamed: ${oldName} to ${newName}`);
  }

  // Aggregate mappings from all levels
  let allMappings = [...oldToNewMappings];

  // Recurse into directories, ensuring to use updated paths if they were renamed
  for (const { newPath } of directoryMappings) {
      const subDirectoryMappings = await removePageIdsFromNames(newPath, depth + 1, verbose);
      allMappings = allMappings.concat(subDirectoryMappings);
  }

  return allMappings;
}

// TODO fix removePageIdsFromNames functions - make sure they account for Notion Pages with same names but different Page IDs properly
// below version works for now
/*
async function removePageIdsFromNames4(dir: string, depth: number = 0, verbose: boolean = false): Promise<RenameMapping[]> {
  if (verbose) console.log(`Processing directory: ${dir} at depth: ${depth}`);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  let nameCounts: Record<string, number> = {};
  let oldToNewMappings: RenameMapping[] = [];
  let directoryMappings: RenameMapping[] = [];

  for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const cleanedName = entry.name.replace(/(.*)(\s\w{32})(_[\w]{1,4})?(\.[\w]{2,12})?$/, '$1$4');
      let newName = cleanedName;
      const pageId = entry.name.match(/\w{32}/)?.[0] || '';

      if (entry.isDirectory() || !oldToNewMappings.some(m => m.oldPath === fullPath)) {
          if (nameCounts[cleanedName]) {
              nameCounts[cleanedName] += 1;
              const count = nameCounts[cleanedName];
              newName += ` _(${count})_`;
          } else {
              nameCounts[cleanedName] = 1;
          }

          const newFullPath = join(dir, newName);
          oldToNewMappings.push({ oldPath: fullPath, newPath: newFullPath });

          if (entry.isDirectory()) {
              directoryMappings.push({ oldPath: fullPath, newPath: newFullPath });
          }
      }
  }

  // Perform renaming operations
  for (const { oldPath, newPath } of oldToNewMappings) {
      await fs.rename(oldPath, newPath);
      if (verbose) console.log(`Renamed: ${basename(oldPath)} to ${basename(newPath)}`);
  }

  // Aggregate mappings from all levels
  let allMappings = [...oldToNewMappings];

  // Recurse into directories, ensuring to use updated paths if they were renamed
  for (const { oldPath, newPath } of directoryMappings) {
      const subDirectoryMappings = await removePageIdsFromNames(newPath, depth + 1, verbose);
      allMappings = allMappings.concat(subDirectoryMappings);
  }

  return allMappings;
}

async function removePageIdsFromNames2(dir: string, depth: number = 0, verbose: boolean = false): Promise<RenameMapping[]> {
  if (verbose) {console.log(`Processing directory: ${dir} at depth: ${depth}`);}
  const entries = await fs.readdir(dir, { withFileTypes: true });

  let nameCounts: Record<string, number> = {};
  let oldToNewMappings: RenameMapping[] = [];
  let directoryMappings: RenameMapping[] = [];

  for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const cleanedName = entry.name.replace(/(.*)(\s\w{32})(\_[\w]{1,4})?(\.[\w]{2,12})?$/, '$1$4');
      let newName = cleanedName;
      const pageId = entry.name.match(/\w{32}/)?.[0] || '';
      const identifier = `${cleanedName}|${pageId}`;

      if (entry.isDirectory() || !oldToNewMappings.some(m => m.oldPath === fullPath)) {
          if (nameCounts[cleanedName]) {
              nameCounts[cleanedName] += 1;
              const count = nameCounts[cleanedName];
              newName += ` _(${count})_`;
          } else {
              nameCounts[cleanedName] = 1;
          }

          const newFullPath = join(dir, newName);
          oldToNewMappings.push({ oldPath: fullPath, newPath: newFullPath });

          if (entry.isDirectory()) {
              directoryMappings.push({ oldPath: fullPath, newPath: newFullPath });
          }
      }
  }

  // Perform renaming operations
  for (const { oldPath, newPath } of oldToNewMappings) {
      await fs.rename(oldPath, newPath);
      if (verbose) {console.log(`Renamed: ${basename(oldPath)} to ${basename(newPath)}`);}
  }

  // Recurse into directories, ensuring to use updated paths if they were renamed
  for (const { oldPath, newPath } of directoryMappings) {
      await removePageIdsFromNames(newPath, depth + 1);
  }

  return oldToNewMappings;
}
*/

/*
async function updateInternalLinks2(dir: string, mappings: RenameMapping[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
      const entryPath = join(dir, entry.name);

      if (entry.isDirectory()) {
          // Recursively update links in subdirectories
          await updateInternalLinks(entryPath, mappings);
      } else {
          // Read the file content
          let content = await fs.readFile(entryPath, 'utf8');

          // Update all internal links based on mappings
          for (const mapping of mappings) {
              const oldLink = relative(dir, mapping.oldName).replace(/\\/g, '/');
              const newLink = relative(dir, mapping.newName).replace(/\\/g, '/');

              // Handle both non-escaped and escaped links
              const patterns = [oldLink, encodeURIComponent(oldLink)].map(pattern =>
                  new RegExp(pattern.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'g')
              );

              patterns.forEach(pattern => {
                  content = content.replace(pattern, newLink);
              });
          }

          // Write the updated content back to the file
          await fs.writeFile(entryPath, content, 'utf8');
      }
  }
}
*/

// List of common binary file extensions
const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.exe', '.dll', '.bin',
  '.zip', '.rar', '.iso', '.tar', '.gz',
  '.mp3', '.wav', '.mp4', '.mov', '.avi'
]);

async function updateInternalLinks(dir: string, mappings: RenameMapping[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  // Create a mapping for basename replacements to simplify link updates
  const basenameMappings: Record<string, string> = mappings.reduce((acc, { oldName, newName }) => {
    const oldBasename = parse(oldName).base;
    const newBasename = parse(newName).base;
    acc[oldBasename] = newBasename;
    return acc;
  }, {} as Record<string, string>);

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recursively update links in subdirectories
      await updateInternalLinks(entryPath, mappings);
    } else {
      // Skip binary files based on file extension
      const extension = extname(entry.name).toLowerCase();
      if (binaryExtensions.has(extension)) {
        continue; // Skip this iteration and move to the next file
      }

      // Process non-binary files
      let content = await fs.readFile(entryPath, 'utf8');
      Object.entries(basenameMappings).forEach(([oldBasename, newBasename]) => {
        const pattern = new RegExp(escapeRegExp(oldBasename), 'g');
        content = content.replace(pattern, newBasename);

        const encodedPattern = new RegExp(escapeRegExp(encodeURIComponent(oldBasename)), 'g');
        content = content.replace(encodedPattern, encodeURIComponent(newBasename));
      });

      // Write the updated content back to the file
      await fs.writeFile(entryPath, content, 'utf8');
    }
  }
}

/*
async function updateInternalLinks_v2(dir: string, mappings: RenameMapping[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  // Create a mapping for basename replacements to simplify link updates
  const basenameMappings: Record<string, string> = {};
  mappings.forEach(({ oldName, newName }) => {
      const oldBasename = parse(oldName).base;
      const newBasename = parse(newName).base;
      basenameMappings[oldBasename] = newBasename;
  });

  for (const entry of entries) {
      const entryPath = join(dir, entry.name);

      if (entry.isDirectory()) {
          // Recursively update links in subdirectories
          await updateInternalLinks(entryPath, mappings);
      } else {
          // Read the file content
          let content = await fs.readFile(entryPath, 'utf8');

          // Update all internal links based on basenameMappings
          Object.entries(basenameMappings).forEach(([oldBasename, newBasename]) => {
              // Regular expression to match the basename considering possible URL encoding
              const pattern = new RegExp(escapeRegExp(oldBasename), 'g');
              content = content.replace(pattern, newBasename);

              // Consider URL encoded version
              const encodedPattern = new RegExp(escapeRegExp(encodeURIComponent(oldBasename)), 'g');
              content = content.replace(encodedPattern, encodeURIComponent(newBasename));
          });

          // Write the updated content back to the file
          await fs.writeFile(entryPath, content, 'utf8');
      }
  }
}
*/

/*
async function removePageIdsFromNames_v3(dir: string): Promise<RenameMapping[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  let nameCounts: Record<string, number> = {};
  let oldToNew: RenameMapping[] = [];
  let processedDuplicates: Set<string> = new Set();

  // Generate new file names and track them for renaming
  for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const cleanedName = entry.name.replace(/(.*)(\s\w{32})(\.md)?$/, '$1$3');
      let newName = cleanedName;
      const pageId = entry.name.match(/\w{32}/)?.[0] || '';

      const identifier = `${cleanedName}|${pageId}`;

      if (!processedDuplicates.has(identifier)) {
          if (nameCounts[cleanedName]) {
              nameCounts[cleanedName] += 1;
              const count = nameCounts[cleanedName];
              newName = `${cleanedName} (${count})`;
          } else {
              nameCounts[cleanedName] = 1;
          }

          oldToNew.push({ oldPath: fullPath, newPath: join(dir, newName) });
          processedDuplicates.add(identifier);
      }
  }

  // Rename files and directories based on the generated mappings
  for (const mapping of oldToNew) {
      await fs.rename(mapping.oldPath, mapping.newPath);
      console.log(`Renamed: ${basename(mapping.oldPath)} TO ${basename(mapping.newPath)}`);
  }

  // Recurse into subdirectories
  for (const entry of entries.filter(e => e.isDirectory())) {
      const subDirPath = join(dir, entry.name);
      // Only recurse if the directory name itself was not modified, otherwise use the new path
      const mapping = oldToNew.find(m => m.oldPath === subDirPath);
      await removePageIdsFromNames(mapping ? mapping.newPath : subDirPath);
  }

  return oldToNew;
}

const removePageIdsFromNames_v1 = async (dir: string) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  let nameCounts: Record<string, number> = {};
  let pageIdMatcher: any = new Set();
  let processedDuplicates: any = new Set();

  // Mini function to check for matching cleanedName and pageId
  const renameMatchInCurrentDir = async (cleanedName: string, pageId: string, fullPath: string, entries: any) => {
    for (const entry of entries) {
      const newFullPath = join(dir, cleanedName);
      let entryCleanedName = entry.name.replace(/(.*)(\s)(\w{32})(\.md)?$/, '$1$4');
      let entryPageId = entry.name.match(/(\w{32})(\.md)?$/)?.[0] || ''; // Extract the page ID including the extension if present

      if (cleanedName === entryCleanedName && pageId === entryPageId) {
        await fs.rename(fullPath, newFullPath);
        return newFullPath;
      }
    }
    return false; // No match found
  };

  for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      // Construct the cleaned name by removing the 32-character UUID
      let cleanedName = entry.name.replace(/(.*)(\s)(\w{32})(\.md)?$/, '$1$4');
      let pageId = entry.name.match(/(\w{32})(\.md)?$/)?.[0] || ''; // Extract the page ID including the extension if present

      // Check for duplicates and append a counter if necessary
      if (cleanedName in nameCounts) {
          if (pageIdMatcher.has(pageId)){
            const count = ++nameCounts[cleanedName]; // Increment the count for this name
            const extension = cleanedName.endsWith('.md') ? '.md' : '';
            cleanedName = cleanedName.replace(/(\.md)?$/, ` __( )__${extension}`);
          } else {
            const count = ++nameCounts[cleanedName]; // Increment the count for this name
            // go through files/folders in current dir to find case where pageIdMatcher.has(pageId)
            const extension = cleanedName.endsWith('.md') ? '.md' : '';
            cleanedName = cleanedName.replace(/(\.md)?$/, ` __(${count})__${extension}`);
            await renameMatchInCurrentDir(cleanedName, pageId, fullPath, entries);
            // remove matching cleanedName and matched pageId combination from "entries"
            processedDuplicates
          }
          
      } else {
          nameCounts[cleanedName] = 1; // Initialize the count for this name
      }

      if (entry.name !== cleanedName) { // Check if the name needs to be changed
          const newFullPath = join(dir, cleanedName);
          await fs.rename(fullPath, newFullPath);
          console.log(`[+] [${pageId}] Renamed: ${entry.name} TO ${cleanedName}`);

          // If it's a directory, recurse into it
          if (entry.isDirectory()) {
              await removePageIdsFromNames(newFullPath);
          }
      } else if (entry.isDirectory()) {
          // If the directory name doesn't need cleaning but still needs to be traversed
          await removePageIdsFromNames(fullPath);
      }
  }
};
*/

// TODO fix function to number files correctly without bugs
/*
const adjustNotionPages = async (
  dir: string,
  skipDirName: string = '',
  filenameChanges: Record<string, string> = {}, // Assuming filenameChanges is a map of string to string,
  namingSeparator: string = '_',
  nameSyntaxSeparator: string = ' - ',
  parentPrefix: string = '',
  isRoot: boolean = true,
  progressTracker: { processed: number; total: number; lastPrintedPercentage: number } | null = null
) => {

  if (isRoot && !progressTracker) {
    // Optionally, count total items for progress indication or other logic
    const totalItems = await countItems(dir, skipDirName);
    console.log(`[+] [index.ts] [adjustNotionPages] Total Items: ${totalItems}`);
    progressTracker = { processed: 0, total: totalItems, lastPrintedPercentage: -10 };
  }
  
  // Get all of the entries for the folder, then alphabetically sort them
  // TODO - add options for different sorting
  const entries = await fs.readdir(dir, { withFileTypes: true });
  console.log(entries);
  const sortedEntries = entries.sort((a, b) => a.name.localeCompare(b.name));

  const baseNameToItemNumber: Record<string, string> = {};

  // Sequential numbering for items at the same level
  
  let currentItemNumber: number = 0;
  for (let i = 0; i < sortedEntries.length; i++) {
    
    const entry: any = sortedEntries[i];  // get next entry based on sorted entries from current directory

    let cleanedBaseName: string = '';
    if (entry.isFile() && entry.name.endsWith('.md')) {
      cleanedBaseName = `${parentPrefix}${entry.name.replace(/\s\w{32}\$/, '.md')}`;
    } else if (entry.isDirectory()){
      cleanedBaseName = `${parentPrefix}${entry.name.replace(/\s\w{32}$/, '')}`;
    }
    console.log(`[+] [index.ts] [adjustNotionPages] ${entry.name} TO ${cleanedBaseName}`)
      
    let itemNumber: string = '';
    if (cleanedBaseName in baseNameToItemNumber) {
      itemNumber = baseNameToItemNumber[cleanedBaseName];
    } else {
      currentItemNumber++;
      itemNumber = (currentItemNumber).toString().padStart(2, '0'); // Ensure 2-digit numbering for new basenames
      baseNameToItemNumber[cleanedBaseName] = itemNumber; 
    }
    
    const newPrefix: string = isRoot ? itemNumber : `${parentPrefix}${namingSeparator}${itemNumber}`;

    const fullPath = join(dir, entry.name);
    const newName = entry.isDirectory() ? newPrefix + nameSyntaxSeparator + cleanedBaseName : newPrefix + ' - ' + entry.name;
    filenameChanges[fullPath] = newName;      // Track file renaming
    const newFullPath = join(dir, newName);
    filenameChanges[fullPath] = newFullPath;  // Track directory renaming

    // Rename operation
    await fs.rename(fullPath, newFullPath);

    // Recursive call for directories
    if (entry.isDirectory()) {
      await adjustNotionPages(newFullPath, skipDirName, filenameChanges, namingSeparator, nameSyntaxSeparator, newPrefix, false, progressTracker);
    }
  }

  // Update and print progress
  if (progressTracker) {
    let progressPercentage = Math.round((progressTracker.processed*2 / progressTracker.total) * 100);
    if (progressPercentage >= progressTracker.lastPrintedPercentage + 10) {
      console.log(`[+] [index.ts] [adjustFilenames] Progress: ${progressTracker.processed*2}/${progressTracker.total} items processed (${progressPercentage}%)`);
      progressTracker.lastPrintedPercentage = progressPercentage;
    } else if (progressTracker.processed == progressTracker.total) {
      console.log(`[+] [index.ts] [adjustFilenames] Progress: ${progressTracker.processed*2}/${progressTracker.total} items processed (${progressPercentage}%)`);
    }
    progressTracker.processed++;
  }

  if (isRoot) {
    console.log("[+] [index.ts] [adjustNotionPages] Filename adjustment complete.");
  }

  return filenameChanges;
};
*/


/*
const updateInternalLinks_v1 = async (dir: string, filenameChanges: object) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recursively process subdirectories
      await updateInternalLinks(fullPath, filenameChanges);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Read the content of the markdown file
      let content = await fs.readFile(fullPath, 'utf8');
      
      // Replace old paths with new paths in the content
      for (const [oldPath, newPath] of Object.entries(filenameChanges)) {
        const escapedOldPath = escapeRegExp(oldPath); // Escape special characters in the old path
        const regex = new RegExp(escapedOldPath, 'g');
        content = content.replace(regex, newPath);
      }
      
      // Write the updated content back to the file
      await fs.writeFile(fullPath, content, 'utf8');
    }
  }
};
*/

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

// Obtain GitHub Environment Variables - assumes running with GitHub actions
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
  console.log(`[+] [index.ts] Started export as task [${taskId}].`);

  
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

    // Check if task.status exists and has pagesExported property before accessing it
    if (task.status && task.status.pagesExported !== undefined) {
      console.log(`[+] [index.ts] Exported ${task.status.pagesExported} pages/items.`);
    } else {
      console.log(`[+] [index.ts] Waiting for export task [${taskId}]...`);
    }

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
        throw new Error("[x] [index.ts] Task finished but file_token cookie not found.");
      }
      console.log(`[+] [index.ts] Export finished.`);
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
  console.log(`[+] [index.ts] Downloading ${round(size / 1000 / 1000)}mb...`);
  
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
  
  console.log(`extractedFiles: ${extractedFiles}`);

  // Notion's export process can split large exports into multiple zip files.
  // These are identified by a "Part-*.zip" naming convention.
  // Here, we filter out these split zip file names for further processing.
  const partFiles = extractedFiles.filter((name) =>
    name.match(/Part-\d+\.zip/)
  );
  console.log(`partFiles: ${partFiles}`);

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
  // TODO fix taxonomy function adjustNotionPages to work properly and use below variable
  let skipDirName = "Private & Shared"; // Define this globally or outside of your function 
  let workspaceDir = join(process.cwd(), "workspace");      // create workspace dir for export work
  let workspaceZip = join(process.cwd(), "workspace.zip");  // create workspace.zip
  console.log('[+] [index.ts] Created workspaceDir and workspaceZip...')

  if (TEST_CODE_MODE=="true" && TEST_NOTION_FILES) { // if locally testing code
    console.log('[+] [index.ts] Running in local testing mode (TEST_CODE_MODE env set)')

    let testSourceDir = TEST_NOTION_FILES // Define the Notion files source directory for testing
    // Delete workspaceDir if it already exists - not needed with fse.copySync using overwrite option??
    if (existsSync(workspaceDir)) {
      try {
        await fs.rm(`${workspaceDir}/.`, { recursive: true}); // synchronously remove all the files before moving on
        console.log(`[+] [index.ts] Old workspaceDir removed or nonexistent...`)
      } catch (err) {
        console.error(`[+] [index.ts] [Error removing workspaceDir] ${err}`)
      }
    } else {
      console.log('[+] [index.ts] No old workspaceDir found...')
    }
    
    //Copy Notion test files to the workspace directory (kind of link temp place for testing files)
    try {
      console.log('[+] [index.ts] Copying Notion Export test files to workspaceDir...')
      fse.copySync(
        testSourceDir, 
        workspaceDir, 
        { 
          overwrite: true, 
          errorOnExist: true, 
          preserveTimestamps: true
        }
      )
      console.log(`[+] [index.ts] Files copied from ${testSourceDir} to workSpaceDir...`)
    } catch (err) {
      console.error(`[x] [index.ts] [Error copying test files] ${err}`)
    }
    
    // Transform filenames and internal attachment links for Obsidian
    let mappings: any;
    try {
      // Adjust filenames and capture the mapping of changes for updating internal links

      // TODO fix below functions and refactor run to use them ideally
      // filenameChanges = await adjustFilenames(workspaceDir);
      // filenameChanges = await adjustNotionPages(workspaceDir, skipDirName='Private & Shared');

      console.log(`[+] [index.ts] Removing Page Ids from file and dir names...`)
      mappings = await removePageIdsFromNames(workspaceDir);
      
    } catch (err) {
      console.error(`[x] [index.ts] [removePageIdsFromNames] ${err}`)
    }

    // TODO add verbose option for printing directory into page
    //fs.readdir(workspaceDir).then(console.log).catch(console.error);
    //await printDirTree(workspaceDir, { level: 2 }).catch(console.error);
    
    try {
      // Use mappings to update internal markdown links
      console.log(`[+] [index.ts] Updating internal links...`)
      await updateInternalLinks(workspaceDir, mappings);
    } catch (err) {
      console.error(`[x] [index.ts] [updateInternalLinks] ${err}`)
    }
    
  } else if (TEST_CODE_MODE!="true" && TEST_GIT_MODE!="true") { // if normally running in Github actions with backup.yml

    console.log('[+] [index.ts] Running default and exporting from Notion (usually via GitHub actions)...')

    // Delete workspaceDir if it already exists - not needed with fse.copySync using overwrite option??
    if (existsSync(workspaceDir)) {
      try {
        await fs.rm(`${workspaceDir}/.`, { recursive: true}); // synchronously remove all the files before moving on
        console.log(`[+] [index.ts] Old workspaceDir removed or nonexistent...`)
      } catch (err) {
        console.error(`[+] [index.ts] [Error removing workspaceDir] ${err}`)
      }
    } else {
      console.log('[+] [index.ts] No old workspaceDir found...')
    }

    // init exportFromNotion with workspaceZip as the destination in markdown format
    await exportFromNotion(workspaceZip, "markdown");
    try {
      await fs.rm(workspaceDir, { recursive: true});  // remove old or existing workspace directory
    } catch (err) {
      console.log("[+] [index.ts] Couldn't remove workspaceDir - might have already been deleted...")
    }
    await fs.mkdir(workspaceDir, { recursive: true });            // create workspace directory
    await extractZip(workspaceZip, workspaceDir);                 // extract zip file to workspace directory
    await fs.unlink(workspaceZip);    // close fs link for file

    console.log("[+] [index.ts] Export downloaded and unzipped.");

    // Transform filenames and internal attachment links for Obsidian
    let mappings: any;
    try {
      // Adjust filenames and capture the mapping of changes for updating internal links

      // TODO fix below functions and refactor run to use them ideally
      // filenameChanges = await adjustFilenames(workspaceDir);
      // filenameChanges = await adjustNotionPages(workspaceDir, skipDirName='Private & Shared');

      console.log(`[+] [index.ts] Removing Page Ids from file and dir names...`)
      mappings = await removePageIdsFromNames(workspaceDir);
      
    } catch (err) {
      console.error(`[x] [index.ts] [removePageIdsFromNames] ${err}`)
    }

    // TODO add verbose option for printing directory into page
    //fs.readdir(workspaceDir).then(console.log).catch(console.error);
    //await printDirTree(workspaceDir, { level: 2 }).catch(console.error);
    
    try {
      // Use mappings to update internal markdown links
      console.log(`[+] [index.ts] Updating internal links...`)
      await updateInternalLinks(workspaceDir, mappings);
    } catch (err) {
      console.error(`[x] [index.ts] [updateInternalLinks] ${err}`)
    }

    console.log("[+] [index.ts] ✅ Finished preparing Notion Export...");

  } else if (TEST_CODE_MODE!="true" && TEST_GIT_MODE=="true" && TEST_NOTION_FILES) { // if testing git functionality only locally
    console.log("[+] [index.ts] Testing git functionality locally...please make 'TEST_GIT_MODE' true next time for this")
    console.log("[+] [index.ts] Exiting index.ts code...")
    return
  } else {
    console.error('[x] Incorrect combination of environment variables set globally or locally from .env file...')
  }

  // FUTURE TODOS:
  // TODO - option to fix long file names and paths for Windows issues ... ugh
  // TODO - option to automatically reformat markdown files in a certain way
  // TODO - option to prepend numbering or organizational string to the front of filename or directory
  // TODO - Obsidian community plugin code somehow integrated into the system?
  // TODO - use web scraper in GitHub to get page order from Notion or wait for notion API to fix it
      // WORKAROUND - rename pages with numbers at the front
};

run();
