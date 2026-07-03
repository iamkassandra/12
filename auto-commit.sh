#!/bin/bash
cd /Users/kass/kas
# Check if there are any changes (modified, deleted, or untracked files)
if [ -n "$(git status --porcelain)" ]; then
  echo "Changes detected, committing and pushing..."
  git add .
  git commit -m "Auto-commit: $(date)"
  git push origin main
else
  echo "No changes detected."
fi
