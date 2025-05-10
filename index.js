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

// Create an MCP server
const server = new McpServer({
    name: "LibGen Book Finder",
    version: "1.0.4",
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
    async ({ query, format = "pdf" }) => {
        try {
            console.log(`[LibGen MCP] Searching for "${query}" in format: ${format}`);
            
            // Normalize the format to lowercase
            format = format.toLowerCase();
            if (!["pdf", "epub"].includes(format)) {
                return { content: [{ type: "text", text: `Unsupported format: ${format}. Currently only pdf and epub are supported.` }] };
            }
            
            // STEP 1: Search for the book
            const searchUrl = `https://libgen.is/search.php?req=${encodeURIComponent(query)}&view=simple&res=25&phrase=1&column=def`;
            console.log(`[LibGen MCP] Searching at URL: ${searchUrl}`);
            
            const response = await axios.get(searchUrl);
            const $ = cheerio.load(response.data);
            
            // Find all book rows in the search results table
            const bookRows = $('table.c tr:not(:first-child)');
            if (bookRows.length === 0) {
                console.log(`[LibGen MCP] No search results found for "${query}"`);
                return { content: [{ type: "text", text: `No results found for "${query}".` }] };
            }
            
            // Extract the first book's data
            const firstBookRow = bookRows.first();
            const bookTitle = firstBookRow.find('td:nth-child(3) a').text().trim();
            const bookAuthor = firstBookRow.find('td:nth-child(2) a').text().trim();
            const bookId = firstBookRow.find('td:nth-child(1)').text().trim();
            
            console.log(`[LibGen MCP] Found book: "${bookTitle}" by ${bookAuthor} (ID: ${bookId})`);
            
            // STEP 2: Navigate to the book details page
            const bookPageUrl = firstBookRow.find('td:nth-child(3) a').attr('href');
            if (!bookPageUrl) {
                console.log(`[LibGen MCP] Could not find book page URL for "${bookTitle}"`);
                return { content: [{ type: "text", text: `Found "${bookTitle}" but could not navigate to its details page.` }] };
            }
            
            // Construct the full URL if it's relative
            const fullBookPageUrl = bookPageUrl.startsWith('http') ? bookPageUrl : `https://libgen.is/${bookPageUrl}`;
            console.log(`[LibGen MCP] Navigating to book page: ${fullBookPageUrl}`);
            
            const bookPageResponse = await axios.get(fullBookPageUrl);
            const $bookPage = cheerio.load(bookPageResponse.data);
            
            // STEP 3: Find the hyperlinked title on the book details page
            console.log(`[LibGen MCP] Looking for title/download links on book page...`);
            
            // Find all the links on the page
            const allLinks = [];
            $bookPage('a').each((_, el) => {
                const link = $bookPage(el);
                const href = link.attr('href');
                const text = link.text().trim();
                if (href) {
                    allLinks.push({ href, text });
                }
            });
            
            // Look for links that could lead to download pages
            // First, try links with the book title or in a heading element
            const titleLinks = allLinks.filter(link => {
                return link.text.includes(bookTitle) || 
                      ($bookPage(`a[href="${link.href}"]`).parent().is('h1, h2, h3')) ||
                      (link.text.length > 15 && !link.href.includes('#'));
            });
            
            // Second, look for links to known download mirrors
            const mirrorLinks = allLinks.filter(link => {
                return link.href.includes('library.lol') || 
                       link.href.includes('libgen.li') || 
                       link.href.includes('libgen.lc') ||
                       link.href.includes('3lib.net') ||
                       link.href.includes('booksc.') ||
                       link.href.includes('cloudflare') ||
                       link.href.includes('ipfs');
            });
            
            // Try title links first, then mirror links
            let possibleLinks = [...titleLinks, ...mirrorLinks];
            
            if (possibleLinks.length === 0) {
                // Fall back to any link with download-related keywords
                possibleLinks = allLinks.filter(link => {
                    return link.href.includes('get') || 
                           link.href.includes('download') || 
                           link.text.toUpperCase() === 'GET' ||
                           link.text.toUpperCase().includes('DOWNLOAD') ||
                           link.text.includes('Mirror');
                });
            }
            
            if (possibleLinks.length === 0) {
                console.log(`[LibGen MCP] Could not find any suitable links on book page: ${fullBookPageUrl}`);
                return { content: [{ type: "text", text: `Found book page for "${bookTitle}" (ID: ${bookId}), but could not find any suitable download links.` }] };
            }
            
            // Use the first suitable link found
            const downloadPageLink = possibleLinks[0];
            console.log(`[LibGen MCP] Found link to download page: ${downloadPageLink.text} -> ${downloadPageLink.href}`);
            
            // Ensure URL is absolute
            const downloadPageUrl = downloadPageLink.href.startsWith('http') 
                ? downloadPageLink.href 
                : new URL(downloadPageLink.href, fullBookPageUrl).href;
            
            // STEP 4: Navigate to the download page
            console.log(`[LibGen MCP] Navigating to download page: ${downloadPageUrl}`);
            const downloadPageResponse = await axios.get(downloadPageUrl);
            const $downloadPage = cheerio.load(downloadPageResponse.data);
            
            // STEP 5: Look for the GET button or other download links
            console.log(`[LibGen MCP] Looking for GET button or download links...`);
            
            // First try to find 'GET' buttons (as seen in your screenshot)
            const getButtons = [];
            $downloadPage('a').each((_, el) => {
                const link = $downloadPage(el);
                const href = link.attr('href');
                const text = link.text().trim();
                
                if (href && text.toUpperCase() === 'GET') {
                    getButtons.push({ href, text });
                    console.log(`[LibGen MCP] Found GET button: ${href}`);
                }
            });
            
            // Then look for links with download keywords or file extensions
            const downloadLinks = [];
            $downloadPage('a').each((_, el) => {
                const link = $downloadPage(el);
                const href = link.attr('href');
                const text = link.text().trim();
                
                if (href && (
                    href.includes('.pdf') || 
                    href.includes('.epub') || 
                    href.includes('download') ||
                    href.includes('get.php') ||
                    href.includes('cloudflare') ||
                    href.includes('ipfs')
                )) {
                    downloadLinks.push({ href, text });
                    console.log(`[LibGen MCP] Found download link: ${text} -> ${href}`);
                }
            });
            
            // Combine all possible download links, prioritizing GET buttons
            const allDownloadLinks = [...getButtons, ...downloadLinks];
            
            if (allDownloadLinks.length === 0) {
                console.log(`[LibGen MCP] No download links found on page: ${downloadPageUrl}`);
                return { content: [{ type: "text", text: `Found download page for "${bookTitle}", but could not find any download links.` }] };
            }
            
            // Use the first download link (prioritizing GET buttons)
            const finalDownloadLink = allDownloadLinks[0];
            console.log(`[LibGen MCP] Using download link: ${finalDownloadLink.text} -> ${finalDownloadLink.href}`);
            
            // Ensure the URL is absolute
            const absoluteDownloadUrl = finalDownloadLink.href.startsWith('http')
                ? finalDownloadLink.href
                : new URL(finalDownloadLink.href, downloadPageUrl).href;
            
            // STEP 6: Download the file
            console.log(`[LibGen MCP] Downloading file from: ${absoluteDownloadUrl}`);
            const fileResponse = await axios({
                method: 'get',
                url: absoluteDownloadUrl,
                responseType: 'arraybuffer'
            });
            
            // Determine file extension from content-type or URL
            let fileExt = format;
            const contentType = fileResponse.headers['content-type'];
            if (contentType && contentType.includes('application/pdf')) {
                fileExt = 'pdf';
            } else if (contentType && contentType.includes('application/epub')) {
                fileExt = 'epub';
            } else if (absoluteDownloadUrl.includes('.pdf')) {
                fileExt = 'pdf';
            } else if (absoluteDownloadUrl.includes('.epub')) {
                fileExt = 'epub';
            }
            
            // Create a safe filename
            const safeTitle = bookTitle.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            const safeAuthor = bookAuthor ? bookAuthor.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50) : 'Unknown';
            const fileName = `${safeTitle}_by_${safeAuthor}.${fileExt}`;
            
            // Save to user's Downloads folder
            const downloadDir = `${os.homedir()}/Downloads`;
            await fse.ensureDir(downloadDir);
            const filePath = `${downloadDir}/${fileName}`;
            
            // Write the file
            fs.writeFileSync(filePath, Buffer.from(fileResponse.data));
            console.log(`[LibGen MCP] File saved successfully to: ${filePath}`);
            
            return {
                content: [
                    { type: "text", text: `✅ Successfully downloaded "${bookTitle}" by ${bookAuthor} in ${fileExt.toUpperCase()} format.\nSaved to: ${filePath}` }
                ]
            };
            
        } catch (error) {
            console.error('[LibGen MCP] Error:', error.message);
            if (error.response) {
                console.error('[LibGen MCP] Error response status:', error.response.status);
            }
            
            // Special handling for common errors
            if (axios.isAxiosError(error)) {
                if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `Failed to connect to LibGen. The site might be down or inaccessible. (${error.message})` 
                        }] 
                    };
                }
                
                if (error.response && error.response.status === 404) {
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `The requested page or file was not found. (HTTP 404)` 
                        }] 
                    };
                }
            }
            
            return {
                content: [
                    { type: "text", text: `An error occurred: ${error.message}` }
                ]
            };
        }
    }
);

// Add a simple greeting resource for testing
server.resource(
    "greeting",
    new ResourceTemplate("greeting://{name}", { list: undefined }),
    async (uri, { name }) => ({
        contents: [{
            uri: uri.href,
            text: `Hello, ${name}!`
        }]
    })
);

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
