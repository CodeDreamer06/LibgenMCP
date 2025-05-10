# LibGen MCP Server

This MCP (Model Context Protocol) server allows you to search for books on LibGen (Library Genesis) and attempt to download them directly to your computer's Downloads folder.

**Disclaimer:** Interacting with LibGen via this tool relies on web scraping, as LibGen does not provide an official API. The structure of the LibGen website can change at any time, which may break the functionality of this server. Use at your own discretion and expect potential inconsistencies or failures in book searching and downloading.

## Prerequisites

*   Node.js (v16 or higher recommended)
*   npm (comes with Node.js)

## MCP Configuration

To use this server with an LLM or other MCP-compatible client, register it with the following configuration. This setup will automatically download and run the server in a temporary environment without requiring a manual global installation:

```json
{
  "mcpServers": {
    "libgen-book-finder": {
      "command": "sh",
      "args": [
        "-c",
        "cd $(mktemp -d) && npm install libgen-mcp-server && npx libgen-mcp-server-cli"
      ]
      // "env": {} // Add environment variables here if your server needs them in the future
    }
  }
}
```

**Explanation of the command:**

*   `sh -c "..."`: Executes the provided string as a shell command.
*   `cd $(mktemp -d)`: Creates a unique temporary directory and changes the current directory into it. This keeps the installation isolated.
*   `npm install libgen-mcp-server`: Installs your package (and its dependencies) into this temporary directory.
*   `npx libgen-mcp-server-cli`: Executes the command-line interface (`libgen-mcp-server-cli`) that was made available by installing your package. `npx` handles finding and running the binary.

This ensures the MCP client always uses the latest version of `libgen-mcp-server` available on npm each time it starts (or according to `npm install`'s caching behavior for subsequent runs within the same client session if the temp directory isn't cleared immediately).

## Available Tools

### `searchAndDownloadBook`

Searches LibGen for a specified book and attempts to download it in the preferred format (PDF or EPUB) to your system's default Downloads folder.

**Parameters:**

*   `query` (string, required): The search term for the book. This can be the book's title, author, ISBN, or other relevant keywords.
    *   Example: `"The Hitchhiker's Guide to the Galaxy"`
*   `format` (string, optional): The preferred book format. Accepts 'PDF' or 'EPUB' (case-insensitive). Defaults to 'PDF' if not specified.
    *   Example: `"epub"`

**Example Usage (conceptual, depends on your LLM/client):**
`LLM, please use the libgen-book-finder to find 'Sapiens by Yuval Noah Harari' and download it as an EPUB.`

This would translate to an MCP tool call like:
`searchAndDownloadBook({ query: "Sapiens by Yuval Noah Harari", format: "epub" })`

## How it Works (Briefly)

1.  The `searchAndDownloadBook` tool receives a query and preferred format.
2.  It constructs a search URL for `libgen.is` (this mirror can change).
3.  It fetches the search results page and parses the HTML to find a matching book and its details page link.
4.  It then fetches the book's detail page and tries to find a direct download link.
5.  If a download link is found, it streams the book content to a file in your OS's default Downloads folder.

**Important Notes:**

*   **Reliability:** The success of finding and downloading books heavily depends on the current state of LibGen's website(s) and their HTML structure. Changes to their site can break this tool.
*   **Download Location:** Books are saved to your operating system's standard Downloads folder (e.g., `~/Downloads` on macOS/Linux, `C:\Users\YourUser\Downloads` on Windows).
*   **Error Handling:** Basic error handling is in place, but due to the nature of web scraping, not all failure scenarios can be perfectly predicted or handled. Check the server console logs for more details if issues occur.
*   **No Browser Simulation:** This tool uses direct HTTP requests (`axios`) and HTML parsing (`cheerio`). It does not simulate a full browser environment, so it may not bypass advanced anti-bot measures like JavaScript challenges or complex CAPTCHAs.
