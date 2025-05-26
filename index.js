#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import fs from "fs";
import fse from "fs-extra";
import os from "os";
import { exec } from "child_process";

// Create an MCP server
const server = new McpServer({
    name: "Book Downloader",
    version: "1.0.0",
});

// Add a tool to search and download books
server.tool(
    "searchAndDownloadBook",
    {
        query: z.string().min(1).describe("The search query for the book. Can include title, author, or other relevant details."),
        format: z.string().optional().default("any").describe("Preferred book format (e.g., 'PDF', 'EPUB', 'MOBI', 'any'). Case-insensitive. Defaults to 'any' to show all available formats."),
        category: z.string().optional().default("fiction, nonfiction").describe("Book categories to search. Options: fiction, nonfiction, comic, magazine, musicalscore, other, unknown. Defaults to 'fiction, nonfiction'."),
        limit: z.number().optional().default(10).describe("Maximum number of search results to return. Defaults to 10."),
        debug: z.boolean().optional().default(false).describe("If true, includes debug information in the response."),
        openFile: z.boolean().optional().default(true).describe("If true, automatically opens the downloaded file using the system's default application. Always prefer automatically opening downloaded files unless otherwise prompted by the user."),
        bookIndex: z.number().optional().describe("IMPORTANT: The LLM should usually select the most appropriate book automatically based on popularity, relevance, and file size without asking the user. Only present options to the user when genuinely confused about which is the best choice. For English-language queries, prefer English books with the original title that match the search exactly. If provided by the user, selects the book at this index from search results."),
    },
    async ({ query, format = "any", category = "fiction, nonfiction", limit = 10, debug = false, openFile = true, bookIndex }) => {
        try {
            console.log(`[Book Downloader] Searching for "${query}", Format: ${format}, Category: ${category}`);
            
            const lowerCaseFormat = format.toLowerCase();
            const formattedExtensions = lowerCaseFormat === 'any' ? 'pdf, epub, mobi, azw3' : lowerCaseFormat;
            
            let books = [];
            const apiKey = 'bfbe4a9e8bmsh2b40b08eb101493p1b2577jsn274aa8e3ed55';
            const apiHost = 'annas-archive-api.p.rapidapi.com';

            // Construct the search URL for Anna's Archive API
            const searchUrl = `https://annas-archive-api.p.rapidapi.com/search`;
            console.log(`[Book Downloader] Searching with Anna's Archive API: ${searchUrl}`);
            
            const searchOptions = {
                method: 'GET',
                url: searchUrl,
                params: {
                    q: query,
                    cat: category,
                    skip: '0',
                    limit: limit.toString(),
                    ext: formattedExtensions,
                    sort: 'mostRelevant',
                    source: 'libgenLi, libgenRs, zLibrary'
                },
                headers: {
                    'x-rapidapi-key': apiKey,
                    'x-rapidapi-host': apiHost
                }
            };
            
            // Perform the search
            const searchResponse = await axios.request(searchOptions);
            const searchResults = searchResponse.data;
            
            if (!searchResults || !searchResults.hits || searchResults.hits.length === 0) {
                const debugInfo = debug ? { searchUrl, params: searchOptions.params } : {};
                return { content: [{ type: "text", text: `No books found for query "${query}" with format "${format}". Try a different search term or format.` }], debugInfo };
            }
            
            console.log(`[Book Downloader] Found ${searchResults.hits.length} potential books in search results.`);
            
            // Process search results
            for (const hit of searchResults.hits) {
                const md5 = hit.md5 || '';
                if (!md5) continue;
                
                books.push({
                    title: hit.title || 'Unknown Title',
                    author: hit.author || 'Unknown Author',
                    publisher: hit.publisher || '',
                    year: hit.year || '',
                    language: hit.language || 'Unknown',
                    extension: hit.extension || '',
                    filesize: hit.filesize ? `${Math.round(hit.filesize / (1024 * 1024))} MB` : 'Unknown Size',
                    md5: md5,
                    coverUrl: hit.cover_url || '',
                    source: hit.source || ''
                });
            }
            
            if (books.length === 0) {
                const debugInfo = debug ? { searchUrl, params: searchOptions.params } : {};
                return { content: [{ type: "text", text: `No books found for query "${query}" with format "${format}". Try a different search term or format.` }], debugInfo };
            }
            
            if (bookIndex === undefined) {
                const bookList = books.map((book, index) => {
                    let details = `(${book.language}, ${book.extension}, ${book.filesize})`;
                    if (book.year) {
                        details = `(${book.language}, ${book.year}, ${book.extension}, ${book.filesize})`;
                    }

                    return `${index}: ${book.title} by ${book.author} ${details}`;
                }).join('\n');
                
                return {
                    content: [
                        { type: "text", text: `Found ${books.length} books matching "${query}":\n${bookList}\n\nTo download a specific book, please provide the book index (e.g., "Download book 0").` }
                    ],
                    books: debug ? books : undefined
                };
            }
            
            if (bookIndex < 0 || bookIndex >= books.length) {
                return { content: [{ type: "text", text: `Invalid bookIndex: ${bookIndex}. Please select a number between 0 and ${books.length - 1}.` }] };
            }
            
            const selectedBook = books[bookIndex];
            console.log(`[Book Downloader] Selected book: "${selectedBook.title}" by ${selectedBook.author}`);
            
            // Get book info from Anna's Archive API
            const infoUrl = `https://annas-archive-api.p.rapidapi.com/info`;
            const infoOptions = {
                method: 'GET',
                url: infoUrl,
                params: { md5: selectedBook.md5 },
                headers: {
                    'x-rapidapi-key': apiKey,
                    'x-rapidapi-host': apiHost
                }
            };
            
            console.log(`[Book Downloader] Getting info for MD5: ${selectedBook.md5}`);
            const infoResponse = await axios.request(infoOptions);
            const bookInfo = infoResponse.data;
            
            // Prepare download URL
            const downloadUrl = `https://annas-archive-api.p.rapidapi.com/download`;
            const downloadOptions = {
                method: 'GET',
                url: downloadUrl,
                params: { md5: selectedBook.md5 },
                headers: {
                    'x-rapidapi-key': apiKey,
                    'x-rapidapi-host': apiHost
                },
                responseType: 'arraybuffer',
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                        if (percentCompleted % 10 === 0 || percentCompleted === 100) {
                            process.stdout.write(`[Book Downloader] Downloading: ${percentCompleted}% \r`);
                        }
                    } else {
                        process.stdout.write(`[Book Downloader] Downloading: ${progressEvent.loaded} bytes \r`);
                    }
                }
            };
            
            console.log(`[Book Downloader] Downloading file for: ${selectedBook.title}`);
            const fileResponse = await axios.request(downloadOptions);
            process.stdout.write('\n');
            
            let fileExt = selectedBook.extension || 'pdf';
            const contentType = fileResponse.headers['content-type'];
            if (contentType) {
                if (contentType.includes('application/pdf')) fileExt = 'pdf';
                else if (contentType.includes('application/epub+zip')) fileExt = 'epub';
                else if (contentType.includes('application/zip')) fileExt = 'zip';
                else if (contentType.includes('application/x-mobipocket-ebook')) fileExt = 'mobi';
            }
            
            const safeTitle = selectedBook.title.replace(/[^a-zA-Z0-9 .-]/g, '_').substring(0, 50);
            const safeAuthor = selectedBook.author ? selectedBook.author.replace(/[^a-zA-Z0-9 .-]/g, '_').substring(0, 30) : 'UnknownAuthor';
            const fileName = `${safeTitle}_by_${safeAuthor}.${fileExt}`;
            
            const downloadDir = `${os.homedir()}/Downloads`;
            await fse.ensureDir(downloadDir);
            const filePath = `${downloadDir}/${fileName}`;
            
            fs.writeFileSync(filePath, Buffer.from(fileResponse.data));
            console.log(`[Book Downloader] File saved successfully to: ${filePath}`);
            
            let fileOpenedMessage = `Downloaded "${selectedBook.title}" by ${selectedBook.author} to: ${filePath}`;
            if (openFile) {
                try {
                    console.log(`[Book Downloader] Attempting to open file: ${filePath}`);
                    const openCmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
                    exec(`${openCmd} "${filePath.replace(/"/g, '\\"')}"`, (error) => {
                        if (error) {
                            console.error(`[Book Downloader] Error opening file: ${error.message}`);
                        } else {
                            console.log(`[Book Downloader] File open command issued successfully.`);
                        }
                    });
                    fileOpenedMessage = `Opening "${selectedBook.title}" by ${selectedBook.author}... (Saved to ${filePath})`;
                } catch (openError) {
                    console.error(`[Book Downloader] Failed to issue open command: ${openError.message}`);
                }
            }
            
            return {
                content: [{ type: "text", text: fileOpenedMessage }]
            };
            
        } catch (error) {
            console.error('[Book Downloader] Error:', error.message, error.stack);
            if (error.response) {
                console.error('[Book Downloader] Error response status:', error.response.status);
                console.error('[Book Downloader] Error response data:', String(error.response.data).substring(0, 500));
            }
            
            let errorMessage = `An error occurred: ${error.message}`;
            if (axios.isAxiosError(error)) {
                if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.message.toLowerCase().includes('timeout')) {
                    errorMessage = `Failed to connect to Anna's Archive API. The service might be down or inaccessible. (${error.message})`;
                } else if (error.response && error.response.status === 404) {
                    errorMessage = `The requested book was not found (HTTP 404). URL: ${error.config?.url}`;
                } else if (error.response) {
                    errorMessage = `HTTP error ${error.response.status} while accessing ${error.config?.url}. (${error.message})`;
                }
            }
            
            return {
                content: [{ type: "text", text: errorMessage }]
            };
        }
    }
);

async function main() {
    console.log("[Book Downloader] Server starting...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("[Book Downloader] Server connected and listening.");
}

main().catch((error) => {
    console.error('[Book Downloader] Server startup error:', error);
    process.exit(1);
});
