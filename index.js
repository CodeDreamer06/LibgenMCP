#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import fse from "fs-extra";
import os from "os";
import path from "path";

// Helper function to sanitize filenames (replace invalid chars with underscore)
const sanitizeFilename = (name) => {
    if (!name || typeof name !== 'string') return 'untitled';
    return name.replace(/[^a-z0-9_.-]/gi, '_').replace(/\s+/g, '_');
};

// Create an MCP server
const server = new McpServer({
    name: "LibGen Book Finder",
    version: "1.0.0",
});

// Add a tool to search and download books
server.tool(
    "searchAndDownloadBook",
    {
        query: z.string().min(1).describe("The search query for the book (e.g., title, author, ISBN)."),
        format: z.string().refine(val => ['pdf', 'epub'].includes(val.toLowerCase()), {
            message: "Format must be 'PDF' or 'EPUB' (case-insensitive).",
        }).optional().default("pdf").describe("Preferred book format ('PDF' or 'EPUB'). Defaults to 'PDF'."),
    },
    async ({ query, format }) => {
        const preferredFormat = format.toLowerCase();
        console.log(`[LibGen MCP] Searching for "${query}" in format "${preferredFormat}"...`);

        try {
            // Step 1: Search LibGen
            // Note: LibGen URLs and HTML structure can change, making this scraper fragile.
            const searchUrl = `http://libgen.is/search.php?req=${encodeURIComponent(query)}&lg_topic=libgen&open=0&view=simple&res=25&phrase=1&column=def`;
            
            console.log(`[LibGen MCP] Fetching search results from: ${searchUrl}`);
            const searchResponse = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
            });
            const $search = cheerio.load(searchResponse.data);

            let bookPageUrl = null;
            let bookTitle = query; // Fallback title

            // Attempt to find book rows. Selectors might need adjustment based on current LibGen HTML.
            // Common tables are 'table.c' or the main results table (often largest with border=1)
            const bookRows = $search('table.c tr:has(td:nth-child(9))'); // Assumes 9th column is extension
            console.log(`[LibGen MCP] Found ${bookRows.length} potential book rows in search results.`);

            for (let i = 0; i < bookRows.length; i++) {
                const row = bookRows.eq(i);
                const rowHtml = row.html();
                if (!rowHtml) continue; 

                // Load row HTML into a new Cheerio instance to scope selectors correctly
                const $row = cheerio.load(rowHtml, null, false); 
                
                const extension = $row('td:nth-of-type(9)').text().trim().toLowerCase();
                // Titles in LibGen search results often have an ID in the <a> tag, or are in the 3rd column.
                const titleLinkElement = $row('td:nth-of-type(3) a[id]').first(); 
                let currentBookPageUrl = titleLinkElement.attr('href');
                const currentBookTitle = titleLinkElement.text().trim() || $row('td:nth-of-type(3)').text().split('\n')[0].trim();

                if (currentBookPageUrl && !currentBookPageUrl.startsWith('http')) {
                    currentBookPageUrl = `http://libgen.is/${currentBookPageUrl.replace(/^\.\//, '')}`;
                }

                console.log(`[LibGen MCP] Checking row: Ext: "${extension}", Title: "${currentBookTitle}", URL: "${currentBookPageUrl}"`);

                if (extension === preferredFormat && currentBookPageUrl) {
                    bookPageUrl = currentBookPageUrl;
                    if (currentBookTitle) bookTitle = currentBookTitle;
                    console.log(`[LibGen MCP] Found matching book: "${bookTitle}", Format: ${extension}, Page URL: ${bookPageUrl}`);
                    break; 
                }
            }

            if (!bookPageUrl) {
                console.log(`[LibGen MCP] No book found matching query "${query}" and format "${preferredFormat}" on the first search results page.`);
                return { content: [{ type: "text", text: `Could not find "${query}" in ${preferredFormat.toUpperCase()} format on LibGen's first results page.` }] };
            }

            // Step 2: Go to the book's page and find the direct download link
            console.log(`[LibGen MCP] Fetching book page: ${bookPageUrl}`);
            const bookPageResponse = await axios.get(bookPageUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
            });
            const $bookPage = cheerio.load(bookPageResponse.data);

            let downloadLink = null;
            console.log(`[LibGen MCP] --- All links on book page ${bookPageUrl}: ---`);
            const allLinks = [];
            $bookPage('a').each((idx, el) => {
                const linkElement = $bookPage(el);
                const href = linkElement.attr('href');
                const text = linkElement.text().trim();
                if (href) { // Only log if href exists
                    allLinks.push({ href, text });
                    console.log(`[LibGen MCP] Link found: TEXT='${text}', HREF='${href}'`);
                }
            });
            console.log(`[LibGen MCP] --- End of links on book page ${bookPageUrl} ---`);

            // Look for download links. This is highly variable across LibGen mirrors and page structures.
            // Common pattern on pages like library.lol/main/MD5... is a link inside an h2 under a div with id 'download'.
            // Or links containing 'get.php'.
            const libraryLolLink = $bookPage('#download h2 a, a[href*="get.php"]').first();
            if (libraryLolLink.length > 0) {
                downloadLink = libraryLolLink.attr('href');
                console.log(`[LibGen MCP] Found download link (library.lol style): ${downloadLink}`);
            }

            // Generic fallback: find links with "GET" text or common mirror domains
            if (!downloadLink) {
                console.log("[LibGen MCP] library.lol style link not found, trying generic fallback...");
                $bookPage('a').each((idx, el) => {
                    const linkElement = $bookPage(el);
                    const href = linkElement.attr('href');
                    const text = linkElement.text().trim().toUpperCase();
                    if (href && (text === 'GET' || /libgen\.(lc|gs|rs|st|rocks|click)|download\.library\.lol|b-ok\.org/i.test(href))) {
                         // Prefer links that seem to point directly to files or known download hosts
                        if (href.match(/\.(pdf|epub)$/i) || text === 'GET' || href.includes('get.php')) {
                           downloadLink = href;
                           console.log(`[LibGen MCP] Found download link (generic GET/mirror): ${downloadLink} with text "${text}"`);
                           return false; // Stop iterating
                        }
                    }
                });
            }
            
            if (!downloadLink) {
                 // Last resort: try any link that has the book title in it and the correct extension (less reliable)
                $bookPage('a').each((idx, el) => {
                    const linkElement = $bookPage(el);
                    const href = linkElement.attr('href');
                    if (href && href.toLowerCase().includes(preferredFormat) && (href.toLowerCase().includes(sanitizeFilename(bookTitle).toLowerCase().substring(0,5)) || bookTitle.split(' ').some(word => href.toLowerCase().includes(word.toLowerCase())) ) ){
                        downloadLink = href;
                        console.log(`[LibGen MCP] Found download link (fallback filename match): ${downloadLink}`);
                        return false;
                    }
                });
            }

            if (!downloadLink) {
                console.log(`[LibGen MCP] Could not find a direct download link on page: ${bookPageUrl}. Searched ${allLinks.length} links.`);
                return { content: [{ type: "text", text: `Found book page for "${bookTitle}", but could not find a direct download link.` }] };
            }

            // Ensure download link is absolute
            if (downloadLink && !downloadLink.startsWith('http')) {
                const bookPageURLObj = new URL(bookPageUrl);
                downloadLink = `${bookPageURLObj.protocol}//${bookPageURLObj.host}${downloadLink.startsWith('/') ? '' : '/'}${downloadLink}`;
                console.log(`[LibGen MCP] Resolved relative download link to: ${downloadLink}`);
            }
            
            // Step 3: Download the book
            const downloadsPath = path.join(os.homedir(), 'Downloads');
            await fse.ensureDir(downloadsPath);
            
            const safeBookTitle = sanitizeFilename(bookTitle);
            const fileName = `${safeBookTitle || 'downloaded_book'}.${preferredFormat}`;
            const filePath = path.join(downloadsPath, fileName);

            console.log(`[LibGen MCP] Attempting to download from: ${downloadLink} to ${filePath}`);
            
            const writer = fs.createWriteStream(filePath);
            const downloadResponse = await axios({
                method: 'get',
                url: downloadLink,
                responseType: 'stream',
                timeout: 30000, // 30 second timeout for download request
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': bookPageUrl // Adding Referer might help with some download servers
                }
            });

            downloadResponse.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    console.log(`[LibGen MCP] Successfully downloaded "${fileName}" to ${downloadsPath}`);
                    resolve({ content: [{ type: "text", text: `Successfully downloaded "${bookTitle}" as ${fileName} to your Downloads folder.` }] });
                });
                writer.on('error', (err) => {
                    console.error('[LibGen MCP] File write error:', err);
                    fs.unlink(filePath, (unlinkErr) => { if (unlinkErr) console.error('[LibGen MCP] Error deleting partial file:', unlinkErr); });
                    reject(new Error(`Failed to write file: ${err.message}`));
                });
                downloadResponse.data.on('error', (err) => {
                    console.error('[LibGen MCP] Download stream error:', err);
                    writer.end();
                    fs.unlink(filePath, (unlinkErr) => { if (unlinkErr) console.error('[LibGen MCP] Error deleting partial file on stream error:', unlinkErr); });
                    reject(new Error(`Failed to download book (stream error): ${err.message}`));
                });
            });

        } catch (error) {
            console.error('[LibGen MCP] Error in searchAndDownloadBook:', error.message);
            if (error.response) {
                console.error('[LibGen MCP] Error response status:', error.response.status);
            }
            if (axios.isAxiosError(error) && (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
                return { content: [{ type: "text", text: `Failed to connect to LibGen or download source. The site might be down or inaccessible. (${error.message})` }] };
            }
            // Ensure the error object passed to MCP is serializable and simple
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `An error occurred: ${errorMessage}. Check server console for details.` }] };
        }
    }
);

// Start receiving messages on stdin and sending messages on stdout
async function main() {
    console.log("[LibGen MCP] Server starting...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("[LibGen MCP] Server connected and listening.");
}

main().catch((error) => {
    console.error('[LibGen MCP] Server startup error:', error);
    process.exit(1);
});
