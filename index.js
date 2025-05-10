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
import { exec } from "child_process";

// Create an MCP server
const server = new McpServer({
    name: "LibGen Book Finder",
    version: "1.0.12",
});

// Add a tool to search and download books
server.tool(
    "searchAndDownloadBook",
    {
        query: z.string().min(1).describe("The search query for the book. IMPORTANT: This tool is very picky, so enter as few words as possible (just the book title). The search has no fuzzy matching capabilities, so complex queries with author names or other details will likely fail."),
        format: z.string().refine(val => ['pdf', 'epub'].includes(val.toLowerCase()), {
            message: "Format must be 'PDF' or 'EPUB' (case-insensitive).",
        }).optional().default("pdf").describe("Preferred book format ('PDF' or 'EPUB'). Defaults to 'PDF'."),
        debug: z.boolean().optional().default(false).describe("If true, includes debug information in the response."),
        openFile: z.boolean().optional().default(true).describe("If true, automatically opens the downloaded file using the system's default application."),
        timeout: z.number().optional().default(60000).describe("Timeout in milliseconds for the download request. Large books may require longer timeouts (default: 60000 = 60 seconds)."),
        bookIndex: z.number().optional().describe("IMPORTANT: The LLM should usually select the most appropriate book automatically based on popularity, relevance, and file size without asking the user. Only present options to the user when genuinely confused about which is the best choice. For English-language queries, prefer English books with the original title that match the search exactly. If provided by the user, selects the book at this index from search results."),
    },
    async ({ query, format = "pdf", debug = false, openFile = true, timeout = 60000, bookIndex }) => {
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
                    html: response.data.substring(0, 500) + '...'
                } : {};
                return { content: [{ type: "text", text: `No books found for query "${query}". Try a simpler search term.` }], debugInfo };
            }
            
            // Extract book information from the search results
            console.log(`[LibGen MCP] Found ${bookRows.length} books in search results.`);
            const books = [];
            bookRows.each((i, row) => {
                const columns = $(row).find('td');
                if (columns.length >= 10) { // The table should have at least 10 columns
                    const id = $(columns[0]).text().trim();
                    const author = $(columns[1]).text().trim();
                    const titleEl = $(columns[2]).find('a');
                    const title = titleEl.text().trim();
                    const publisher = $(columns[3]).text().trim();
                    const year = $(columns[4]).text().trim();
                    const pages = $(columns[5]).text().trim();
                    const language = $(columns[6]).text().trim();
                    const size = $(columns[7]).text().trim();
                    const extension = $(columns[8]).text().trim().toLowerCase();
                    const detailsLink = $(columns[9]).find('a').attr('href');
                    const md5 = titleEl.attr('href')?.match(/md5=([A-F0-9]+)/i)?.[1] || '';
                    
                    if (title && (format === 'any' || extension.includes(format))) {
                        books.push({
                            id,
                            author,
                            title,
                            publisher,
                            year,
                            pages,
                            language,
                            size,
                            extension,
                            detailsLink,
                            md5
                        });
                    }
                }
            });
            
            if (books.length === 0) {
                const debugInfo = debug ? {
                    searchUrl,
                    format,
                    foundRows: bookRows.length,
                    html: response.data.substring(0, 500) + '...'
                } : {};
                return { content: [{ type: "text", text: `No books found in ${format} format for query "${query}". Try a different format or a simpler search term.` }], debugInfo };
            }
            
            // PHASE 1: If no bookIndex is provided, return the list of books for the LLM to choose from
            if (bookIndex === undefined) {
                const bookList = books.map((book, index) => (
                    `${index}: "${book.title}" by ${book.author} (${book.year}, ${book.extension}, ${book.size})`
                )).join('\n');
                
                console.log(`[LibGen MCP] Returning list of ${books.length} books for LLM selection`);
                return {
                    content: [
                        { type: "text", text: `Found ${books.length} books matching "${query}" in ${format} format. Please select a book by specifying the bookIndex parameter:\n\n${bookList}\n\nTo download a specific book, call this tool again with the same query, format, and the bookIndex parameter.` }
                    ],
                    books: debug ? books : undefined
                };
            }
            
            // PHASE 2: Download the selected book
            if (bookIndex < 0 || bookIndex >= books.length) {
                return { content: [{ type: "text", text: `Invalid bookIndex: ${bookIndex}. Please select a number between 0 and ${books.length - 1}.` }] };
            }
            
            const selectedBook = books[bookIndex];
            console.log(`[LibGen MCP] Selected book: "${selectedBook.title}" by ${selectedBook.author} (${selectedBook.extension})`);
            
            if (!selectedBook.detailsLink) {
                const debugInfo = debug ? { selectedBook, books } : {};
                return { content: [{ type: "text", text: `Could not find a details link for the selected book "${selectedBook.title}".` }], debugInfo };
            }
            
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
            console.log(`[LibGen MCP] Downloading file with timeout of ${timeout}ms...`);
            const fileResponse = await axios({
                method: 'get',
                url: absoluteDownloadUrl,
                responseType: 'arraybuffer',
                timeout: timeout,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
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
            const safeTitle = selectedBook.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            const safeAuthor = selectedBook.author ? selectedBook.author.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50) : 'Unknown';
            const fileName = `${safeTitle}_by_${safeAuthor}.${fileExt}`;
            
            // Save to user's Downloads folder
            const downloadDir = `${os.homedir()}/Downloads`;
            await fse.ensureDir(downloadDir);
            const filePath = `${downloadDir}/${fileName}`;
            
            // Write the file
            fs.writeFileSync(filePath, Buffer.from(fileResponse.data));
            console.log(`[LibGen MCP] File saved successfully to: ${filePath}`);
            
            // Open the file if requested
            let fileOpened = false;
            if (openFile) {
                try {
                    console.log(`[LibGen MCP] Attempting to open file: ${filePath}`);
                    // Use the 'open' command on macOS to open the file with default application
                    exec(`open "${filePath}"`, (error) => {
                        if (error) {
                            console.error(`[LibGen MCP] Error opening file: ${error.message}`);
                        }
                    });
                    fileOpened = true;
                    console.log(`[LibGen MCP] File opened successfully.`);
                } catch (openError) {
                    console.error(`[LibGen MCP] Failed to open file: ${openError.message}`);
                }
            }
            
            return {
                content: [
                    { type: "text", text: fileOpened 
                        ? `Opening "${selectedBook.title.split('[')[0].trim()}" by ${selectedBook.author.split(',')[0].trim()}...` 
                        : `Downloaded "${selectedBook.title.split('[')[0].trim()}" by ${selectedBook.author.split(',')[0].trim()} to: ${filePath}` 
                    }
                ]
            };
            
        } catch (error) {
            console.error('[LibGen MCP] Error:', error.message);
            if (error.response) {
                console.error('[LibGen MCP] Error response status:', error.response.status);
            }
            
            // Special handling for common errors
            if (axios.isAxiosError(error)) {
                if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `Failed to connect to LibGen. The site might be down or inaccessible. (${error.message})` 
                        }] 
                    };
                }
                
                if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `The download timed out. This usually happens with very large files. Try again with a longer timeout parameter (e.g., 120000 for 120 seconds) or a different book.` 
                        }] 
                    };
                }
                
                if (error.message.includes('maxContentLength') || error.message.includes('maxBodyLength')) {
                    return { 
                        content: [{ 
                            type: "text", 
                            text: `The file is too large to download. Try a different book or format.` 
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
