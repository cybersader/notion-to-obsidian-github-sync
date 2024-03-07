# Obtain test environment variables from .env file
Get-Content .env | foreach {
    $name, $value = $_.split('=', 2)
    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('#')) {
      continue
    }
    # Remove leading and trailing single or double quotes from the value
    $value = $value.Trim().Trim('"', "'")
    Set-Content env:\$name $value
}

# Ensure the backup directory exists and is empty
$BackupDir = "backup-repo"

# Try to resolve the full path of $BackupDir
try {
    $FullBackupDir = Resolve-Path $BackupDir -ErrorAction Stop
    $Exists = $true
} catch {
    $Exists = $false
}

if ($Exists) {
    # Prepend the extended-length path prefix to the full path
    $ExtendedLengthPath = "\\?\$($FullBackupDir.Path)"
    
    Write-Output "[+] Clearing '$ExtendedLengthPath' directory..."
    # Use the extended-length path to clear the directory\
    try {
        Get-ChildItem $ExtendedLengthPath -Force | Remove-Item -Recurse -Force
        
    } catch {
        Write-Output "[x] Deletion of backup-repo did not work..."
    }
    
} 

# Create backup-repo directory
Write-Output "[+] Creating '$BackupDir' directory..."
# Create the directory if it doesn't exist
New-Item -ItemType Directory -Path $BackupDir | Out-Null

Set-Location $BackupDir

Write-Output "[+] Temporary Backup Directory Set..."

# --- LOCATION AT THIS POINT IN SCRIPT: "backup-repo"

# Clone or pull the backup repository
if (Test-Path ".git") {
    Write-Output "[+] Repository exists, pulling the latest changes..."
    git pull
} else {
    Write-Output "[+] Cloning the notion-backup-related repository..."
    $RepoUrl = "https://${env:REPO_PERSONAL_ACCESS_TOKEN}@github.com/${env:REPO_USERNAME}/${env:REPO_NAME}.git"
    Write-Output "[+] Repo being cloned for Notion export files - $RepoUrl"
    git clone $RepoUrl .
}

# Set up git identity
Write-Output "[+] Configuring git identity..."
git config --local user.email $REPO_EMAIL
git config --local user.name $REPO_USERNAME

Set-Location ..
# --- LOCATION AT THIS POINT IN SCRIPT: "notion-to-obsidian"

# Install dependencies
Write-Output "[+] Installing dependencies..."
npm install  # Install dependencies for notion-to-obsidian via package.json and package-lock.json

# Check for TEST_GIT_MODE to decide action
if ($env:TEST_GIT_MODE -eq "true") {
    Write-Output "[+] Git testing mode enabled - using test directory..."
    $BackupSourceDir = $env:TEST_NOTION_FILES
} else {
    if ($env:TEST_CODE_MODE -eq "true") {
        Write-Output "[+] Running backup in TEST_CODE_MODE..."
        npm run backup
        $BackupSourceDir = "workspace"
    } else {
        Write-Output "[+] Running backup..."
        npm run backup
        $BackupSourceDir = "workspace"
    }
}

# Logic to handle APPEND_MODE
# https://stackoverflow.com/questions/25916197/copy-items-from-source-to-destination-if-they-dont-already-exist
if ($env:APPEND_MODE -eq "true") {
    # APPEND MODE
    Write-Output "[+] APPEND MODE - appending new files from [$BackupSourceDir] TO [$BackupDir]..."
    
    #$exclude = Get-ChildItem -Recurse $BackupDir
    # TODO - Account for 260 character limit in Windows
    #Copy-Item -Recurse "$BackupSourceDir\*" $BackupDir -Verbose -Exclude $exclude # Copy Notion export files to backup-repo but exclude existing files

    # Copies all files and subdirectories (including empty ones) from the source to the destination.
    # /COPYALL copies all file information (attributes, timestamps, etc.).
    # Does not delete files in the destination that are not in the source.
    robocopy "$BackupSourceDir" "$BackupDir" /E /COPYALL /XD ".git" /XF *git* /R:5 /W:5  /NFL /NDL /NJH /NJS /nc /ns /np


} else {
    # REPLACE MODE
    Write-Output "[+] REPLACE MODE (default) - copying new files from [$BackupSourceDir] TO [$BackupDir]..."
    Get-ChildItem $BackupDir | Remove-Item -Recurse -Force

    # TODO - Account for 260 character limit in Windows
    #Copy-Item "$BackupSourceDir\*" $BackupDir -Recurse

    # Mirrors the source directory contents to the destination, including deleting files
    # in the destination that are not present in the source.
    robocopy "$BackupSourceDir" "$BackupDir" /MIR /COPYALL /XD ".git" /XF *git* /R:5 /W:5  /NFL /NDL /NJH /NJS /nc /ns /np
}

Set-Location $BackupDir
# --- LOCATION AT THIS POINT IN SCRIPT: "backup-repo"

# Add changes to git, commit, and push
Write-Output "[+] Adding files under $BackupDir..."
Write-Output "[+] Current directory: $(Get-Location)"

git add .
$changes = git status --porcelain
if ($changes) {
    Write-Output "[+] Committing and pushing changes..."
    git commit -m "Local Automated Notion workspace backup"
    git push
} else {
    Write-Output "[+] No changes to commit."
}

Set-Location ..
# --- LOCATION AT THIS POINT IN SCRIPT: "notion-to-obsidian"

# Remove temporary workspace directory

try {
    $FullBackupDir = Resolve-Path ''workspace'' -ErrorAction Stop
    $Exists = $true
} catch {
    $Exists = $false
}

if ($Exists) {
    # Prepend the extended-length path prefix to the full path
    $ExtendedLengthPath = "\\?\$($FullBackupDir.Path)"
    
    Write-Output "[+] Clearing ''$ExtendedLengthPath'' directory..."
    # Use the extended-length path to clear the directory
    Get-ChildItem $ExtendedLengthPath -Force | Remove-Item -Recurse -Force
}

Write-Output "[!] If you need to remove the backup-repo dir, then have long paths enabled or use the RMDIR command."

Write-Output "[✅] Backup process completed."