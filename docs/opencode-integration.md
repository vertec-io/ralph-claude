# OpenCode Integration Guide

OpenCode is an alternative AI agent that Ralph supports alongside Claude. This guide covers OpenCode-specific configuration, supported providers and models, differences from Claude, and troubleshooting.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Supported Providers and Models](#supported-providers-and-models)
- [Differences from Claude](#differences-from-claude)
- [Server Mode for Remote Attachment](#server-mode-for-remote-attachment)
- [Troubleshooting](#troubleshooting)

## Overview

OpenCode is a multi-provider CLI that supports various AI models from different providers. Unlike Claude Code CLI (which only works with Anthropic models), OpenCode can use models from Anthropic, OpenAI, Amazon Bedrock, and Google Vertex AI.

### When to Use OpenCode

- **Model flexibility**: Need to use specific models (e.g., claude-haiku for cost optimization)
- **Multi-provider**: Want to switch between providers (Anthropic, OpenAI, etc.)
- **Cost control**: Use cheaper models for simpler tasks via per-story model overrides
- **Remote TUI**: Need to attach to a running session from another machine

### When to Use Claude

- **Simplicity**: Just want to use your Anthropic subscription
- **Stability**: Claude Code CLI is battle-tested with Ralph
- **MCP support**: Need Model Context Protocol tools (browser automation, etc.)

## Configuration

### Basic Setup

1. **Install OpenCode** (if running locally):
   ```bash
   npm install -g opencode-ai
   ```

2. **Create configuration file** in your project root:
   ```json
   // opencode.json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": "allow"
   }
   ```

   The `"permission": "allow"` setting enables fully autonomous operation without permission prompts.

3. **Set API key** for your chosen provider:
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   # or
   export OPENAI_API_KEY="sk-..."
   ```

### Using OpenCode with Ralph

Select OpenCode as your agent using any of these methods (in order of precedence):

**1. Per-story override** (highest priority):
```json
{
  "userStories": [
    {
      "id": "US-001",
      "title": "Simple task",
      "agent": "opencode",
      "model": "anthropic/claude-haiku-4"
    }
  ]
}
```

**2. CLI flag**:
```bash
./ralph.sh tasks/my-task --agent opencode
```

**3. Environment variable**:
```bash
export RALPH_AGENT=opencode
./ralph.sh tasks/my-task
```

**4. PRD configuration**:
```json
{
  "agent": "opencode",
  "userStories": [...]
}
```

### Configuration File (opencode.json)

Ralph includes an `opencode.json` in the project root with autonomous permissions enabled. OpenCode looks for this file in the current working directory.

**Full configuration options:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow",
  "providers": {
    "anthropic": {
      "disabled": false
    },
    "openai": {
      "disabled": false
    }
  },
  "model": "anthropic/claude-sonnet-4"
}
```

**Permission options:**

| Value | Description |
|-------|-------------|
| `"allow"` | Allow all operations (recommended for Ralph) |
| `"ask"` | Prompt for each operation |
| `"deny"` | Deny all operations |
| `{ "tool": "allow" }` | Granular per-tool permissions |

For granular permissions, see the [OpenCode permissions documentation](https://opencode.ai/docs/permissions/).

## Supported Providers and Models

OpenCode supports multiple AI providers. Each requires its own API credentials.

### Anthropic (Claude)

**Environment Variable:** `ANTHROPIC_API_KEY`

**Models:**
| Model | Description | Cost |
|-------|-------------|------|
| `anthropic/claude-sonnet-4` | Best balance of speed and capability | $$ |
| `anthropic/claude-sonnet-4-20250514` | Specific dated version | $$ |
| `anthropic/claude-haiku-4` | Fast and affordable | $ |
| `anthropic/claude-opus-4` | Most capable, slower | $$$ |

**Example:**
```json
{
  "id": "US-001",
  "agent": "opencode",
  "model": "anthropic/claude-haiku-4"
}
```

### OpenAI (GPT)

**Environment Variable:** `OPENAI_API_KEY`

**Models:**
| Model | Description | Cost |
|-------|-------------|------|
| `openai/gpt-4o` | Latest GPT-4 Omni | $$ |
| `openai/gpt-4o-mini` | Smaller, faster GPT-4 | $ |
| `openai/gpt-4-turbo` | GPT-4 Turbo | $$ |
| `openai/o1` | Reasoning model | $$$ |
| `openai/o1-mini` | Smaller reasoning model | $$ |

**Example:**
```json
{
  "id": "US-001",
  "agent": "opencode",
  "model": "openai/gpt-4o-mini"
}
```

### Amazon Bedrock

**Environment Variables:**
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_DEFAULT_REGION` (default: `us-east-1`)

**Models:**
| Model | Description |
|-------|-------------|
| `bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0` | Claude on AWS |
| `bedrock/anthropic.claude-3-haiku-20240307-v1:0` | Haiku on AWS |
| `bedrock/amazon.titan-text-premier-v1:0` | Amazon Titan |

### Google Vertex AI

**Environment Variables:**
- `GOOGLE_APPLICATION_CREDENTIALS` (path to service account JSON)
- `GOOGLE_CLOUD_PROJECT` (optional, project ID)

**Models:**
| Model | Description |
|-------|-------------|
| `vertex/gemini-1.5-pro` | Gemini 1.5 Pro |
| `vertex/gemini-1.5-flash` | Gemini 1.5 Flash |

### Model Selection per Story

Use different models for different tasks to optimize cost:

```json
{
  "agent": "opencode",
  "userStories": [
    {
      "id": "US-001",
      "title": "Complex architecture work",
      "model": "anthropic/claude-sonnet-4"
    },
    {
      "id": "US-002",
      "title": "Simple documentation update",
      "model": "anthropic/claude-haiku-4"
    },
    {
      "id": "US-003",
      "title": "Experimental GPT task",
      "model": "openai/gpt-4o-mini"
    }
  ]
}
```

## Differences from Claude

### Feature Comparison

| Feature | Claude Code CLI | OpenCode |
|---------|-----------------|----------|
| Model selection | No (uses subscription) | Yes (`--model` flag) |
| Multi-provider | No (Anthropic only) | Yes |
| MCP tools | Yes | No |
| Server mode | No | Yes (`opencode serve`) |
| Remote TUI attach | Via SSH + tmux | Native (`opencode attach`) |
| Output format | `stream-json`, `text` | `json`, `default` |
| Permission flag | `--dangerously-skip-permissions` | Config file |

### Invocation Differences

**Claude:**
```bash
# Prompt via stdin, output via stdout
echo "prompt" | claude --print --dangerously-skip-permissions
```

**OpenCode:**
```bash
# Prompt as argument
opencode run --model anthropic/claude-sonnet-4 "prompt"
```

### Prompt Preprocessing

Ralph automatically adjusts prompts based on the selected agent. Claude-specific content (like MCP browser tools) is filtered out for OpenCode.

The prompt uses agent-specific markers:
```markdown
<!-- agent:claude -->
1. Use MCP browser tools, Playwright, etc.
<!-- /agent:claude -->
<!-- agent:opencode -->
1. Use Playwright, etc.
<!-- /agent:opencode -->
```

### Error Handling

Both agents use similar error detection patterns:
- Rate limiting (HTTP 429, "rate limit")
- API errors (HTTP 500/502/503, "API error")
- Timeout errors
- Authentication failures

Ralph's automatic failover works with both agents - if one fails repeatedly, Ralph switches to the other.

## Server Mode for Remote Attachment

OpenCode supports a server mode that allows remote TUI attachment.

### Enable Server Mode

Set the environment variable:
```bash
export RALPH_OPENCODE_SERVE=true
export RALPH_OPENCODE_PORT=4096  # optional, default is 4096
```

Or in Docker:
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY \
  -e RALPH_AGENT=opencode \
  -e RALPH_OPENCODE_SERVE=true \
  -p 4096:4096 \
  ralph
```

### How It Works

1. When `RALPH_OPENCODE_SERVE=true`, the OpenCode wrapper starts `opencode serve` in the background
2. Each Ralph iteration uses `opencode run --attach` to connect to the server
3. The server runs on the configured port (default: 4096)

### Attach from Remote Client

From another machine with OpenCode installed:

```bash
# Attach to the running session
opencode attach http://hostname:4096
```

This gives you a full TUI interface to observe and interact with the agent.

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_OPENCODE_SERVE` | `false` | Enable server mode |
| `RALPH_OPENCODE_PORT` | `4096` | Port for the server |
| `RALPH_OPENCODE_HOSTNAME` | `0.0.0.0` | Bind address |

## Troubleshooting

### API Key Issues

**Problem:** "API key not found" or authentication errors

**Solution:**
1. Verify your API key is set:
   ```bash
   echo $ANTHROPIC_API_KEY  # Should show sk-ant-...
   ```

2. Check the key is valid with a direct test:
   ```bash
   opencode run --model anthropic/claude-haiku-4 "Say hello"
   ```

3. For Docker, ensure the key is passed:
   ```bash
   docker run -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY ...
   ```

### Model Not Found

**Problem:** "Model not found" or "Invalid model" errors

**Solution:**
1. Check the model format is `provider/model`:
   ```bash
   # Correct
   opencode run --model anthropic/claude-haiku-4 "test"
   
   # Wrong
   opencode run --model claude-haiku-4 "test"
   ```

2. Verify the model exists for your provider:
   ```bash
   opencode --help  # Lists available models
   ```

### Permission Denied Errors

**Problem:** OpenCode prompts for permission during Ralph execution

**Solution:**
1. Ensure `opencode.json` exists in the project root:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": "allow"
   }
   ```

2. In Docker, the config is at `/app/ralph/opencode.json` and copied to the project directory

### Server Mode Issues

**Problem:** Cannot connect to OpenCode server

**Solution:**
1. Check the server is running:
   ```bash
   curl http://localhost:4096
   ```

2. Check the server log:
   ```bash
   cat /tmp/opencode-serve.log
   ```

3. Verify port isn't blocked:
   ```bash
   netstat -tlnp | grep 4096
   ```

4. Restart the server:
   ```bash
   pkill -f "opencode serve"
   # It will restart on next iteration
   ```

**Problem:** "Server security warning" about OPENCODE_SERVER_PASSWORD

This warning is normal for local development. For production, set:
```bash
export OPENCODE_SERVER_PASSWORD=your-secure-password
```

### Failover Not Working

**Problem:** Ralph doesn't switch to OpenCode after Claude failures

**Solution:**
1. Check failover is enabled (not set to 0):
   ```bash
   echo $RALPH_FAILOVER_THRESHOLD  # Should be > 0, default is 3
   ```

2. Check both agent wrappers exist and are executable:
   ```bash
   ls -la agents/claude.sh agents/opencode.sh
   ```

3. Check progress.txt for failure logs:
   ```bash
   grep -i "FAILURE\|FAILOVER" tasks/my-task/progress.txt
   ```

### Output Format Differences

**Problem:** Ralph can't parse OpenCode output

**Solution:**
OpenCode uses `--format json` while Claude uses `--output-format stream-json`. The agent wrappers handle this automatically, but if you're debugging:

```bash
# Claude output format
OUTPUT_FORMAT=stream-json agents/claude.sh < prompt.txt

# OpenCode output format  
OUTPUT_FORMAT=json agents/opencode.sh < prompt.txt
```

### Performance Issues

**Problem:** OpenCode is slower than Claude

**Considerations:**
1. Different models have different latencies
2. Server mode adds minimal overhead
3. Check if you're hitting rate limits:
   ```bash
   grep -i "rate" /tmp/opencode-serve.log
   ```

**Solution:**
Try a faster model for non-critical tasks:
```json
{
  "id": "US-001",
  "agent": "opencode",
  "model": "anthropic/claude-haiku-4"
}
```

### Getting Help

- **OpenCode Documentation:** https://opencode.ai/docs/
- **OpenCode Issues:** https://github.com/opencode-ai/opencode/issues
- **Ralph Issues:** Check AGENTS.md for patterns specific to this project
