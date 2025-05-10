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
    version: "1.0.6",
});

// Add a tool to search and download books
server.tool(
    "searchAndDownloadBook",
    {
        query: z.string().min(1).describe("The search query for the book (e.g., title, author, ISBN)."),
        format: z.string().refine(val => ['pdf', 'epub'].includes(val.toLowerCase()), {
            message: "Format must be 'PDF' or 'EPUB' (case-insensitive).",
        }).optional().default("pdf").describe("Preferred book format ('PDF' or 'EPUB'). Defaults to 'PDF'."),
        debug: z.boolean().optional().default(false).describe("If true, includes debug information in the response."),
    },
    async ({ query, format = "pdf", debug = false }) => {
        try {
            console.log(`[LibGen MCP] Searching for "${query}" in format: ${format}`);
            
            // Normalize the format to lowercase
            format = format.toLowerCase();
            if (!["pdf", "epub"].includes(format)) {
                return { content: [{ type: "text", text: `Unsupported format: ${format}. Currently only pdf and epub are supported.` }] };
            }
            
            // STEP 1: Search for the book with exact URL pattern from user example
            const searchUrl = `https://libgen.is/search.php?req=${encodeURIComponent(query)}&open=0&res=25&view=simple&phrase=1&column=def`;
            console.log(`[LibGen MCP] Searching at URL: ${searchUrl}`);
            
            const response = await axios.get(searchUrl);
            const $ = cheerio.load(response.data);
            
            // Find all book rows in the search results table
            const bookRows = $('table.c tr:not(:first-child)');
            if (bookRows.length === 0) {
                const debugInfo = debug ? {
                    searchUrl,
                    htmlSnippet: $.html().substring(0, 1000) + '...',
                    message: 'No table rows found matching the selector pattern'
                } : null;
                
                console.log(`[LibGen MCP] No search results found for "${query}"`);
                return { 
                    content: [{ 
                        type: "text", 
                        text: debug 
                            ? `No results found for "${query}".\n\nDebug Info: ${JSON.stringify(debugInfo, null, 2)}` 
                            : `No results found for "${query}".` 
                    }] 
                };
            }
            
            // Get ALL book results to let the LLM choose
            const books = [];
            bookRows.each((index, row) => {
                if (index < 5) { // Limit to first 5 books for practical reasons
                    const $row = $(row);
                    const id = $row.find('td:nth-child(1)').text().trim();
                    const author = $row.find('td:nth-child(2)').text().trim();
                    const titleEl = $row.find('td:nth-child(3) a');
                    const title = titleEl.text().trim();
                    const md5 = titleEl.attr('href')?.match(/md5=([A-F0-9]+)/i)?.[1] || '';
                    const year = $row.find('td:nth-child(5)').text().trim();
                    const pages = $row.find('td:nth-child(6)').text().trim();
                    const language = $row.find('td:nth-child(7)').text().trim();
                    const size = $row.find('td:nth-child(8)').text().trim();
                    const extension = $row.find('td:nth-child(9)').text().trim();
                    
                    if (title && md5) {
                        books.push({
                            id,
                            md5,
                            title,
                            author,
                            year,
                            pages,
                            language,
                            size,
                            extension
                        });
                    }
                }
            });
            
            // If debug mode is enabled, return all books for LLM to choose
            if (debug) {
                console.log(`[LibGen MCP] Returning ${books.length} book options to LLM for selection`);
                return {
                    content: [{
                        type: "text",
                        text: `Found ${books.length} books matching "${query}". Please choose one by ID or MD5 hash:\n\n${books.map(b => 
                            `ID: ${b.id}, MD5: ${b.md5}\nTitle: ${b.title}\nAuthor: ${b.author}, Year: ${b.year}, Format: ${b.extension}, Size: ${b.size}\n`
                        ).join('\n')}`
                    }]
                };
            }
            
            // Otherwise, use the first book automatically
            if (books.length === 0) {
                console.log(`[LibGen MCP] Could not extract book information from search results`);
                return { 
                    content: [{ 
                        type: "text", 
                        text: `Found search results for "${query}" but could not extract book information.` 
                    }] 
                };
            }
            
            const selectedBook = books[0];
            console.log(`[LibGen MCP] Selected book: "${selectedBook.title}" by ${selectedBook.author} (MD5: ${selectedBook.md5})`);
            
            // STEP 2: Navigate to the book details page using the specific URL pattern from user example
            const bookPageUrl = `https://libgen.is/book/index.php?md5=${selectedBook.md5}`;
            console.log(`[LibGen MCP] Navigating to book page: ${bookPageUrl}`);
            
            const bookPageResponse = await axios.get(bookPageUrl);
            const $bookPage = cheerio.load(bookPageResponse.data);
            
            // STEP 3: Find the hyperlinked title on the book details page (using exact pattern from user example)
            console.log(`[LibGen MCP] Looking for title links to mirror sites...`);
            
            // Get all links and their details for debugging
            const allLinks = [];
            $bookPage('a').each((_, el) => {
                const link = $bookPage(el);
                const href = link.attr('href');
                const text = link.text().trim();
                if (href) {
                    allLinks.push({ href, text });
                }
            });
            
            // Start debug data collection for potential error response
            const debugData = {
                bookUrl: bookPageUrl,
                selectedBook: selectedBook,
                allLinksFound: allLinks,
                message: null
            };
            
            // Search for links matching the pattern user showed: "<a href="http://books.ms/main/[MD5]">[Book Title]</a>"
            // Example pattern 1: <a href="http://books.ms/main/96F997237D1FFFE83467F130C350F275">Atomic Habits: Tiny Changes, Remarkable Results</a>
            // Example pattern 2: <a href="http://library.lol/main/[MD5]">Book Title</a>
            let mirrorLinks = allLinks.filter(link => {
                return (link.href.includes('/main/') && link.text.includes(selectedBook.title)) ||
                       (link.href.includes('books.ms/main/') || link.href.includes('library.lol/main/'));
            });
            
            // If we didn't find specific mirror links, try matching by MD5 hash
            if (mirrorLinks.length === 0) {
                mirrorLinks = allLinks.filter(link => 
                    link.href.toLowerCase().includes(selectedBook.md5.toLowerCase()) && 
                    (link.text.length > 10 || link.text.toUpperCase() === 'GET')
                );
            }
            
            if (mirrorLinks.length === 0) {
                // If still not found, collect all promising links
                debugData.message = "No exact mirror links found. Here are all links on the page:";
                
                if (debug) {
                    console.log(`[LibGen MCP] Could not find specific mirror links on book page: ${bookPageUrl}`);
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `Found book page for "${selectedBook.title}" (MD5: ${selectedBook.md5}), but could not find the specific download mirror links.\n\nDebug Info: ${JSON.stringify(debugData, null, 2)}` 
                        }] 
                    };
                } else {
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `Found book page for "${selectedBook.title}", but could not find a direct download link.\n\nTo see all available links, try again with debug=true.` 
                        }] 
                    };
                }
            }
            
            // Use the first mirror link found
            const mirrorLink = mirrorLinks[0];
            console.log(`[LibGen MCP] Found mirror link: ${mirrorLink.text} -> ${mirrorLink.href}`);
            
            // STEP 4: Navigate to the download page (mirror site)
            console.log(`[LibGen MCP] Navigating to download mirror: ${mirrorLink.href}`);
            const downloadPageResponse = await axios.get(mirrorLink.href);
            const $downloadPage = cheerio.load(downloadPageResponse.data);
            
            // STEP 5: Look for the GET button (using exact pattern from user example)
            console.log(`[LibGen MCP] Looking for GET button...`);
            
            // Example from user: <a href="https://download.books.ms/main/2274000/96f997237d1fffe83467f130c350f275/James%20Clear%20-%20Atomic%20Habits_%20Tiny%20Changes%2C%20Remarkable%20Results-Penguin%20Publishing%20Group%20%282018%29.epub">GET</a>
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
            
            // Collect all links on download page for debugging
            const downloadPageLinks = [];
            $downloadPage('a').each((_, el) => {
                const link = $downloadPage(el);
                const href = link.attr('href');
                const text = link.text().trim();
                if (href) {
                    downloadPageLinks.push({ href, text });
                }
            });
            
            const downloadDebugData = {
                mirrorUrl: mirrorLink.href,
                allLinksOnDownloadPage: downloadPageLinks,
                getButtonsFound: getButtons,
                pageContent: debug ? $downloadPage.html().substring(0, 2000) + '...' : null
            };
            
            if (getButtons.length === 0) {
                if (debug) {
                    console.log(`[LibGen MCP] No GET buttons found on download page: ${mirrorLink.href}`);
                    return {
                        content: [{
                            type: "text",
                            text: `Found download page for "${selectedBook.title}", but could not find any GET buttons.\n\nDebug Info: ${JSON.stringify(downloadDebugData, null, 2)}`
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Found download page for "${selectedBook.title}", but could not find the final download link.\n\nTo see all available links, try again with debug=true.`
                        }]
                    };
                }
            }
            
            // Use the first GET button
            const downloadButton = getButtons[0];
            console.log(`[LibGen MCP] Using GET button link: ${downloadButton.href}`);
            
            // Ensure the URL is absolute
            const absoluteDownloadUrl = downloadButton.href.startsWith('http')
                ? downloadButton.href
                : new URL(downloadButton.href, mirrorLink.href).href;
            
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

// No resources defined - we're just using tools

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
