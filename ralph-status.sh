#!/bin/bash
# Ralph Status API Server
# Provides a simple HTTP endpoint for checking Ralph status
#
# Usage: ./ralph-status.sh [task-directory] [port]
# Example: ./ralph-status.sh tasks/my-task 8080
#
# Environment variables:
#   RALPH_STATUS_PORT      HTTP port (default: 8080)
#   RALPH_TASK_DIR         Task directory path (alternative to CLI arg)
#
# Returns JSON:
# {
#   "task": "task-name",
#   "agent": "claude",
#   "iteration": { "current": 5, "max": 10 },
#   "stories": { "complete": 3, "total": 10, "progress": 30.0 },
#   "status": "running|paused|complete|idle",
#   "currentStory": { "id": "US-001", "title": "..." },
#   "lastUpdate": "2026-01-20T12:00:00Z"
# }

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse arguments
TASK_DIR="${1:-${RALPH_TASK_DIR:-}}"
PORT="${2:-${RALPH_STATUS_PORT:-8080}}"

# Validate task directory
if [ -z "$TASK_DIR" ]; then
  echo "Usage: $0 <task-directory> [port]"
  echo "Or set RALPH_TASK_DIR environment variable"
  exit 1
fi

# Resolve paths
if [[ "$TASK_DIR" = /* ]]; then
  FULL_TASK_DIR="$TASK_DIR"
else
  FULL_TASK_DIR="$(pwd)/$TASK_DIR"
fi

PRD_FILE="$FULL_TASK_DIR/prd.json"
PROGRESS_FILE="$FULL_TASK_DIR/progress.txt"

# Validate files exist
if [ ! -f "$PRD_FILE" ]; then
  echo "Error: prd.json not found at $PRD_FILE"
  exit 1
fi

echo "Ralph Status API starting on port $PORT"
echo "Task directory: $FULL_TASK_DIR"
echo "Endpoints:"
echo "  GET /        - Full status"
echo "  GET /status  - Full status (alias)"
echo "  GET /health  - Health check"
echo ""
echo "Press Ctrl+C to stop"

# Export variables for Node.js
export PORT="$PORT"
export PRD_FILE="$PRD_FILE"
export PROGRESS_FILE="$PROGRESS_FILE"
export FULL_TASK_DIR="$FULL_TASK_DIR"

# Use Node.js for HTTP server (available in Docker image)
exec node << 'NODESCRIPT'
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PRD_FILE = process.env.PRD_FILE;
const PROGRESS_FILE = process.env.PROGRESS_FILE;
const FULL_TASK_DIR = process.env.FULL_TASK_DIR;

function generateStatus() {
  try {
    const prdData = JSON.parse(fs.readFileSync(PRD_FILE, 'utf8'));
    
    // Extract task name from taskDir path
    const taskName = prdData.taskDir 
      ? path.basename(prdData.taskDir)
      : (prdData.project || 'unknown');
    
    // Count stories
    const stories = prdData.userStories || [];
    const totalStories = stories.length;
    const completeStories = stories.filter(s => s.passes === true).length;
    
    // Get current (next incomplete) story - sorted by priority
    const incompleteStories = stories
      .filter(s => s.passes !== true)
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
    const currentStory = incompleteStories[0] || null;
    
    // Determine status
    let status = 'idle';
    if (completeStories === totalStories && totalStories > 0) {
      status = 'complete';
    } else if (fs.existsSync(PROGRESS_FILE)) {
      const progressContent = fs.readFileSync(PROGRESS_FILE, 'utf8');
      const lastLines = progressContent.split('\n').slice(-20).join('\n');
      if (lastLines.includes('PAUSED')) {
        status = 'paused';
      } else {
        status = 'running';
      }
    }
    
    // Get last update time
    let lastUpdate = '';
    if (fs.existsSync(PROGRESS_FILE)) {
      const stats = fs.statSync(PROGRESS_FILE);
      lastUpdate = stats.mtime.toISOString();
    }
    
    // Count iterations from progress file
    let currentIteration = 0;
    if (fs.existsSync(PROGRESS_FILE)) {
      const progressContent = fs.readFileSync(PROGRESS_FILE, 'utf8');
      const matches = progressContent.match(/^## \d{4}-\d{2}-\d{2}/gm);
      currentIteration = matches ? matches.length : 0;
    }
    
    // Calculate progress percentage
    const progressPct = totalStories > 0 
      ? Math.round((completeStories * 1000 / totalStories)) / 10 
      : 0;
    
    return {
      task: taskName,
      description: prdData.description || '',
      branch: prdData.branchName || '',
      agent: prdData.agent || 'claude',
      iteration: {
        current: currentIteration,
        max: 10  // Default, could be read from config
      },
      stories: {
        complete: completeStories,
        total: totalStories,
        progress: progressPct
      },
      currentStory: currentStory ? {
        id: currentStory.id || '',
        title: currentStory.title || ''
      } : { id: '', title: '' },
      status: status,
      lastUpdate: lastUpdate
    };
  } catch (err) {
    return { error: err.message };
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
    const status = generateStatus();
    res.writeHead(200);
    res.end(JSON.stringify(status, null, 2));
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
NODESCRIPT
