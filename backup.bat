#!/bin/bash

# Load environment variables from .env file
set -o allexport
source .env
set +o allexport

# Ensure the backup directory exists and is empty
BACKUP_DIR="backup-repo"
mkdir -p "$BACKUP_DIR"
cd "$BACKUP_DIR" || exit

# Clone or pull the backup repository
# Check that the .git directory exists indicating a cloned repository
if [ -d ".git" ]; then
    echo "Repository exists, pulling the latest changes..."
    git pull
else
    echo "[+] Cloning the repository..."
    # Use the environment variables for repository details
    # The token is used for authentication with the repository
    git clone "https://${REPO_USERNAME}:${REPO_PERSONAL_ACCESS_TOKEN}@${REPO_URL}/${REPO_USERNAME}/${REPO_NAME}" .
fi

# Install dependencies
echo "[+] Installing dependencies..."
npm install

# Run backup script if not testing
# use TEST_GIT_NOTION_FILES if doing git testing, else do regular notion backup
if [ "$TEST_GIT_MODE" = "true" ]; then
    echo "[+] Git testing mode enabled - using test directory..."
    BACKUP_SOURCE_DIR="$TEST_GIT_NOTION_ZIP"
else
    echo "[+] Running backup..."
    npm run backup                      # Run backup script based on package.json
    BACKUP_SOURCE_DIR="../workspace"
fi

# Logic to handle APPEND_MODE vs regular
if [ "$APPEND_MODE" = "true" ]; then
    echo "[+] Append mode enabled - appending changes..."
    # Assuming `npm run backup` updates files in a 'workspace' directory
    # Copy the updated files to the backup repository
    cp -a "$BACKUP_SOURCE_DIR"/. .
else
    echo "[+] Append mode disabled - replacing files..."
    # Clear existing files and copy new ones from the workspace
    # Be cautious with these commands
    git rm -rf ./* || echo "No files to remove."
    git clean -fdx
    cp -a "$BACKUP_SOURCE_DIR"/. .
fi

# Add changes to git
git add .

# Check if there are any changes to commit
if git diff --staged --quiet; then
    echo "[+] No changes to commit."
else
    echo "[+] Committing and pushing changes..."
    git commit -m "Local Automated Notion workspace backup"
    git push
fi

echo "[+] Backup process completed."