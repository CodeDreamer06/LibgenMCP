#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import fse from "fs-extra";
import os from "os";
import { exec } from "child_process";

// Create an MCP server
const server = new McpServer({
    name: "LibGen Book Finder",
    version: "1.0.14",
});

// Add a tool to search and download books
server.tool(
    "searchAndDownloadBook",
    {
        query: z.string().min(1).describe("The search query for the book. IMPORTANT: This tool is very picky, so enter as few words as possible (just the book title). The search has no fuzzy matching capabilities, so complex queries with author names or other details will likely fail."),
        searchDomain: z.enum(['general', 'fiction']).optional().default('general').describe("The domain to search: 'general' (non-fiction, textbooks) or 'fiction'. Defaults to 'general'."),
        format: z.string().optional().default("any").describe("Preferred book format (e.g., 'PDF', 'EPUB', 'MOBI', 'any'). Case-insensitive. Defaults to 'any' to show all available formats."),
        debug: z.boolean().optional().default(false).describe("If true, includes debug information in the response."),
        openFile: z.boolean().optional().default(true).describe("If true, automatically opens the downloaded file using the system's default application."),
        bookIndex: z.number().optional().describe("IMPORTANT: The LLM should usually select the most appropriate book automatically based on popularity, relevance, and file size without asking the user. Only present options to the user when genuinely confused about which is the best choice. For English-language queries, prefer English books with the original title that match the search exactly. If provided by the user, selects the book at this index from search results."),
    },
    async ({ query, searchDomain = 'general', format = "any", debug = false, openFile = true, bookIndex }) => {
        try {
            console.log(`[LibGen MCP] Searching for "${query}", Domain: ${searchDomain}, Format: ${format}`);
            
            const lowerCaseFormat = format.toLowerCase();
            
            let books = [];
            let searchPerformedUrl = "";
            let initialHtmlContent = "";

            if (searchDomain === 'fiction') {
                searchPerformedUrl = `https://libgen.is/fiction/?q=${encodeURIComponent(query)}`;
                console.log(`[LibGen MCP] Searching fiction at URL: ${searchPerformedUrl}`);
                
                const response = await axios.get(searchPerformedUrl);
                initialHtmlContent = response.data;
                const $ = cheerio.load(initialHtmlContent);
                const bookRows = $('table.catalog tbody tr');

                if (bookRows.length === 0) {
                    const debugInfo = debug ? { searchUrl: searchPerformedUrl, html: initialHtmlContent.substring(0, 500) + '...' } : {};
                    return { content: [{ type: "text", text: `No fiction books found for query "${query}". Try a simpler search term or the 'general' searchDomain.` }], debugInfo };
                }
                console.log(`[LibGen MCP] Found ${bookRows.length} potential fiction books in search results.`);

                bookRows.each((i, row) => {
                    const author = $(row).find('td:nth-child(1) ul.catalog_authors a').first().text().trim();
                    const series = $(row).find('td:nth-child(2)').text().trim();
                    const titleLink = $(row).find('td:nth-child(3) p a[href^="/fiction/"]').first();
                    const title = titleLink.text().trim();
                    const md5 = titleLink.attr('href')?.match(/\/fiction\/([A-F0-9]+)/i)?.[1];
                    const language = $(row).find('td:nth-child(4)').text().trim();
                    const fileInfo = $(row).find('td:nth-child(5)').text().trim();
                    
                    let parsedExtension = '';
                    let parsedSize = '';
                    const fileInfoMatch = fileInfo.match(/^([a-zA-Z0-9]+)\s*\/\s*(.*)$/);
                    if (fileInfoMatch) {
                        parsedExtension = fileInfoMatch[1].toLowerCase();
                        parsedSize = fileInfoMatch[2];
                    }

                    let downloadPageLink = '';
                    const mirrorAnchors = $(row).find('td:nth-child(6) ul.record_mirrors_compact li a');
                    mirrorAnchors.each((idx, anchor) => {
                        const href = $(anchor).attr('href');
                        if (href && md5 && (href.includes(`books.ms/fiction/${md5}`) || href.includes(`books.ms/fiction/`) && href.endsWith(md5)) ) {
                            downloadPageLink = href;
                            return false;
                        }
                    });
                    
                    if (!downloadPageLink && md5) {
                        mirrorAnchors.each((idx, anchor) => {
                            const href = $(anchor).attr('href');
                            if (href && href.toLowerCase().includes(md5.toLowerCase())) {
                            }
                        });
                    }

                    if (title && md5 && downloadPageLink && (lowerCaseFormat === 'any' || parsedExtension === lowerCaseFormat)) {
                        books.push({
                            author,
                            title,
                            series,
                            language,
                            extension: parsedExtension,
                            size: parsedSize,
                            md5,
                            downloadPageLink,
                            searchDomain: 'fiction'
                        });
                    }
                });
            } else {
                searchPerformedUrl = `https://libgen.is/search.php?req=${encodeURIComponent(query)}&open=0&res=25&view=simple&phrase=1&column=def`;
                console.log(`[LibGen MCP] Searching general at URL: ${searchPerformedUrl}`);
                
                const response = await axios.get(searchPerformedUrl);
                initialHtmlContent = response.data;
                const $ = cheerio.load(initialHtmlContent);
                
                const bookRows = $('table.c tr:not(:first-child)');
                if (bookRows.length === 0) {
                    const debugInfo = debug ? { searchUrl: searchPerformedUrl, html: initialHtmlContent.substring(0, 500) + '...' } : {};
                    return { content: [{ type: "text", text: `No general books found for query "${query}". Try a simpler search term or the 'fiction' searchDomain.` }], debugInfo };
                }
                console.log(`[LibGen MCP] Found ${bookRows.length} potential general books in search results.`);

                bookRows.each((i, row) => {
                    const columns = $(row).find('td');
                    if (columns.length >= 10) {
                        const id = $(columns[0]).text().trim();
                        const author = $(columns[1]).text().trim();
                        const titleEl = $(columns[2]).find('a');
                        const title = titleEl.text().trim();
                        const publisher = $(columns[3]).text().trim();
                        const year = $(columns[4]).text().trim();
                        const pages = $(columns[5]).text().trim();
                        const language = $(columns[6]).text().trim();
                        const size = $(columns[7]).text().trim();
                        const parsedExtension = $(columns[8]).text().trim().toLowerCase();
                        const detailsLink = $(columns[9]).find('a').attr('href');
                        const md5 = titleEl.attr('href')?.match(/md5=([A-F0-9]+)/i)?.[1] || '';
                        
                        if (title && md5 && (lowerCaseFormat === 'any' || parsedExtension.includes(lowerCaseFormat))) {
                            books.push({
                                id, author, title, publisher, year, pages, language, size, 
                                extension: parsedExtension, detailsLink, md5,
                                searchDomain: 'general'
                            });
                        }
                    }
                });
            }
            
            if (books.length === 0) {
                const debugInfo = debug ? { searchUrl: searchPerformedUrl, format: lowerCaseFormat, html: initialHtmlContent.substring(0, 500) + '...' } : {};
                return { content: [{ type: "text", text: `No books found in ${lowerCaseFormat === 'any' ? 'any' : lowerCaseFormat} format for query "${query}" in ${searchDomain} domain. Try a different format, search term, or domain.` }], debugInfo };
            }
            
            if (bookIndex === undefined) {
                const bookList = books.map((book, index) => {
                    let details = `(${book.language}, ${book.extension}, ${book.size})`;
                    if (book.searchDomain === 'fiction' && book.series) {
                        details = `(${book.language}, Series: ${book.series}, ${book.extension}, ${book.size})`;
                    } else if (book.searchDomain === 'general' && book.year) {
                        details = `(${book.language}, ${book.year}, ${book.extension}, ${book.size})`;
                    }
                    return `${index}: "${book.title}" by ${book.author} ${details}`;
                }).join('\n');
                
                console.log(`[LibGen MCP] Returning list of ${books.length} books for LLM selection (Domain: ${searchDomain})`);
                return {
                    content: [
                        { type: "text", text: `Found ${books.length} books matching "${query}" (Format: ${lowerCaseFormat === 'any' ? 'any requested' : lowerCaseFormat}, Domain: ${searchDomain}). Please select a book by specifying the bookIndex parameter:\n\n${bookList}\n\nTo download a specific book, call this tool again with the same query, format, domain, and the bookIndex parameter.` }
                    ],
                    books: debug ? books : undefined
                };
            }
            
            if (bookIndex < 0 || bookIndex >= books.length) {
                return { content: [{ type: "text", text: `Invalid bookIndex: ${bookIndex}. Please select a number between 0 and ${books.length - 1}.` }] };
            }
            
            const selectedBook = books[bookIndex];
            console.log(`[LibGen MCP] Selected book (${selectedBook.searchDomain}): "${selectedBook.title}" by ${selectedBook.author} (${selectedBook.extension})`);
            
            let finalDownloadLink = '';
            let downloadSourcePageUrl = '';

            if (selectedBook.searchDomain === 'fiction') {
                if (!selectedBook.downloadPageLink) {
                    return { content: [{ type: "text", text: `Could not find a download page link for the selected fiction book "${selectedBook.title}".` }], debugInfo: debug ? { selectedBook } : {} };
                }
                downloadSourcePageUrl = selectedBook.downloadPageLink;
                console.log(`[LibGen MCP] Navigating to fiction download source page: ${downloadSourcePageUrl}`);
                const fictionDownloadPageResponse = await axios.get(downloadSourcePageUrl);
                const $fictionDownloadPage = cheerio.load(fictionDownloadPageResponse.data);
                
                const getButton = $fictionDownloadPage('a').filter((i, el) => $fictionDownloadPage(el).text().trim().toUpperCase() === 'GET').first();
                finalDownloadLink = getButton.attr('href');

                if (!finalDownloadLink) {
                    const fictionDebugData = {
                        downloadSourcePageUrl,
                        selectedBook,
                        allLinksOnPage: [],
                        pageContent: debug ? $fictionDownloadPage.html().substring(0,1000) : undefined
                    };
                    if(debug){
                         $fictionDownloadPage('a').each((_, el) => {
                            const link = $fictionDownloadPage(el);
                            fictionDebugData.allLinksOnPage.push({ href: link.attr('href'), text: link.text().trim() });
                        });
                    }
                    return { content: [{ type: "text", text: `Found fiction download page for "${selectedBook.title}", but could not find the final 'GET' download link.` }], debugInfo: debug ? fictionDebugData : {} };
                }
                console.log(`[LibGen MCP] Found GET button for fiction book: ${finalDownloadLink}`);

            } else {
                if (!selectedBook.detailsLink) {
                    const debugInfo = debug ? { selectedBook, books } : {};
                    return { content: [{ type: "text", text: `Could not find a details link for the selected general book "${selectedBook.title}".` }], debugInfo };
                }
                
                const bookPageUrl = selectedBook.detailsLink.startsWith('http') ? selectedBook.detailsLink : `https://libgen.is${selectedBook.detailsLink}`;
                console.log(`[LibGen MCP] Navigating to general book page: ${bookPageUrl}`);
                
                const bookPageResponse = await axios.get(bookPageUrl);
                const $bookPage = cheerio.load(bookPageResponse.data);
                
                let mirrorLinkHref = '';
                $bookPage('a').each((_, el) => {
                    const href = $bookPage(el).attr('href');
                    if (href && (href.includes('books.ms/main/') || href.includes('library.lol/main/')) && href.toLowerCase().includes(selectedBook.md5.toLowerCase())) {
                        const text = $bookPage(el).text().trim();
                        if (text.toLowerCase().includes(selectedBook.title.substring(0,10).toLowerCase()) || text.match(/libgen|library|books\.ms|mirror/i) || text.length < 30) {
                           mirrorLinkHref = href;
                           return false;
                        }
                    }
                });

                if (!mirrorLinkHref) {
                     $bookPage('a').each((_, el) => {
                        const href = $bookPage(el).attr('href');
                        if (href && href.toLowerCase().includes(selectedBook.md5.toLowerCase())) {
                            const text = $bookPage(el).text().trim();
                            if (text.toUpperCase() === 'GET' || text.length < 30) {
                                mirrorLinkHref = href;
                                return false; 
                            }
                        }
                    });
                }

                if (!mirrorLinkHref) {
                    const debugData = { bookUrl: bookPageUrl, selectedBook, allLinksFound: [] };
                     if(debug){
                        $bookPage('a').each((_, el) => {
                            const link = $bookPage(el);
                            debugData.allLinksFound.push({ href: link.attr('href'), text: link.text().trim() });
                        });
                    }
                    return { content: [{ type: "text", text: `Found general book page for "${selectedBook.title}", but could not find a download mirror link.` }], debugInfo: debug ? debugData : {} };
                }
                
                downloadSourcePageUrl = mirrorLinkHref;
                console.log(`[LibGen MCP] Navigating to general book download mirror: ${downloadSourcePageUrl}`);
                const downloadPageResponse = await axios.get(downloadSourcePageUrl);
                const $downloadPage = cheerio.load(downloadPageResponse.data);
                
                const getButtons = [];
                $downloadPage('a').each((_, el) => {
                    const link = $downloadPage(el);
                    const href = link.attr('href');
                    const text = link.text().trim();
                    if (href && text.toUpperCase() === 'GET') {
                        getButtons.push({ href, text });
                    }
                });

                if (getButtons.length === 0) {
                    const generalDebugData = { mirrorUrl: downloadSourcePageUrl, selectedBook, allLinksOnDownloadPage: [], pageContent: debug ? $downloadPage.html().substring(0,1000) : undefined };
                    if(debug){
                        $downloadPage('a').each((_, el) => {
                           const link = $downloadPage(el);
                           generalDebugData.allLinksOnDownloadPage.push({ href: link.attr('href'), text: link.text().trim() });
                        });
                    }
                    return { content: [{ type: "text", text: `Found general book download page for "${selectedBook.title}", but could not find the 'GET' button.` }], debugInfo: debug ? generalDebugData : {} };
                }
                finalDownloadLink = getButtons[0].href;
                console.log(`[LibGen MCP] Found GET button for general book: ${finalDownloadLink}`);
            }
            
            if (!finalDownloadLink) {
                 return { content: [{ type: "text", text: `Could not resolve a final download link for "${selectedBook.title}".` }], debugInfo: debug ? { selectedBook, downloadSourcePageUrl } : {} };
            }

            const absoluteDownloadUrl = finalDownloadLink.startsWith('http')
                ? finalDownloadLink
                : new URL(finalDownloadLink, downloadSourcePageUrl).href;
            
            console.log(`[LibGen MCP] Downloading file from: ${absoluteDownloadUrl}`);
            const fileResponse = await axios({
                method: 'get',
                url: absoluteDownloadUrl,
                responseType: 'arraybuffer',
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                        if (percentCompleted % 10 === 0 || percentCompleted === 100) {
                           process.stdout.write(`[LibGen MCP] Downloading: ${percentCompleted}% \r`);
                        }
                    } else {
                         process.stdout.write(`[LibGen MCP] Downloading: ${progressEvent.loaded} bytes \r`);
                    }
                }
            });
            process.stdout.write('\n');
            
            let fileExt = selectedBook.extension;
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
            console.log(`[LibGen MCP] File saved successfully to: ${filePath}`);
            
            let fileOpenedMessage = `Downloaded "${selectedBook.title.split('[')[0].trim()}" by ${selectedBook.author.split(',')[0].trim()} to: ${filePath}`;
            if (openFile) {
                try {
                    console.log(`[LibGen MCP] Attempting to open file: ${filePath}`);
                    const openCmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
                    exec(`${openCmd} "${filePath.replace(/"/g, '\\"')}"`, (error) => {
                        if (error) {
                            console.error(`[LibGen MCP] Error opening file: ${error.message}`);
                        } else {
                             console.log(`[LibGen MCP] File open command issued successfully.`);
                        }
                    });
                    fileOpenedMessage = `Opening "${selectedBook.title.split('[')[0].trim()}" by ${selectedBook.author.split(',')[0].trim()}... (Saved to ${filePath})`;
                } catch (openError) {
                    console.error(`[LibGen MCP] Failed to issue open command: ${openError.message}`);
                }
            }
            
            return {
                content: [{ type: "text", text: fileOpenedMessage }]
            };
            
        } catch (error) {
            console.error('[LibGen MCP] Error:', error.message, error.stack);
            if (error.response) {
                console.error('[LibGen MCP] Error response status:', error.response.status);
                console.error('[LibGen MCP] Error response data:', String(error.response.data).substring(0, 500));
            }
            
            let errorMessage = `An error occurred: ${error.message}`;
            if (axios.isAxiosError(error)) {
                if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.message.toLowerCase().includes('timeout')) {
                    errorMessage = `Failed to connect to LibGen or a download mirror. The site might be down or inaccessible. (${error.message})`;
                } else if (error.response && error.response.status === 404) {
                    errorMessage = `The requested page or file was not found (HTTP 404). URL: ${error.config?.url}`;
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
    console.log("[LibGen MCP] Server starting...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("[LibGen MCP] Server connected and listening.");
}

main().catch((error) => {
    console.error('[LibGen MCP] Server startup error:', error);
    process.exit(1);
});
