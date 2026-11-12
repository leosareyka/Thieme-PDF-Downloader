// ==UserScript==
// @name         Thieme PDF Downloader
// @version      1.6
// @description  Download all PDFs and merge them into a single file
// @author       The_Dead_2, Revezd
// @match        https://*.thieme.de/ebooks/*
// @grant        none
// @noframes
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// ==/UserScript==

(function () {
    'use strict';

    const TIMEOUT_MS = 60000;
    const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    const CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/cmaps/';

    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    let progressEl = null;
    let busy = false;

    // ---------- Progress UI ----------

    function createProgressUI() {
        removeProgressUI();

        const el = document.createElement("div");
        Object.assign(el.style, {
            position: "fixed",
            inset: "auto 20px 20px auto",
            margin: "0",
            backgroundColor: "rgba(0, 0, 0, 0.85)",
            color: "#ffffff",
            padding: "12px 16px",
            borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: "14px",
            fontWeight: "bold",
            zIndex: "2147483647",
            pointerEvents: "none",
        });
        el.innerText = "Downloading...";

        if (HTMLElement.prototype.hasOwnProperty("popover")) {
            el.popover = "manual";
            document.body.appendChild(el);
            el.showPopover();
        } else {
            const dialogEl = findPdfDialog();
            (dialogEl && dialogEl.hasAttribute("open") ? dialogEl : document.body).appendChild(el);
        }

        // Keep a direct reference: the element may live inside a shadow root,
        // where document.getElementById cannot find it.
        progressEl = el;
    }

    function updateProgressUI(text, current, total) {
        if (!progressEl) return;
        const percent = total > 0 ? ` (${Math.round(current / total * 100)} %)` : "";
        progressEl.innerText = text + percent;
    }

    function removeProgressUI() {
        progressEl?.remove();
        progressEl = null;
    }

    // ---------- Helpers ----------

    function truncateString(str, num) {
        return str.length > num ? str.slice(0, num) + "..." : str;
    }

    function getBookName() {
        const lineOne = document.querySelector(".lineOne")?.textContent?.trim();
        const lineTwo = document.querySelector(".lineTwo")?.textContent?.trim();
        const name = [lineTwo, lineOne].filter(Boolean).join(" - ") || "UnknownBook";
        return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    }

    function getBaseUrl() {
        const url = String(window.location);
        return url.substring(0, url.indexOf("/ebooks"));
    }

    // Resolve a pdf-link attribute to an absolute URL and only accept
    // PDF files on the same origin as the current page.
    function resolvePdfUrl(link) {
        if (!link) return null;
        try {
            const url = link.startsWith("/") ? new URL(getBaseUrl() + link) : new URL(link, location.href);
            if (url.origin !== location.origin) return null;
            if (!url.pathname.toLowerCase().endsWith(".pdf")) return null;
            return url.href;
        } catch {
            return null;
        }
    }

    function findAllInShadow(root, selector) {
        let results = [...root.querySelectorAll(selector)];
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                results = results.concat(findAllInShadow(el.shadowRoot, selector));
            }
        });
        return results;
    }

    function findPdfDialog() {
        const t = document.querySelector('t-dialog[dialog-id="pdfDialog"]');
        return t?.shadowRoot?.querySelector("dialog") ?? null;
    }

    async function sha256Hex(text) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    }

    // ---------- PDF processing ----------

    // Returns the normalized text of every page. Pages whose text could not be
    // extracted are returned as null, so they are always kept.
    async function extractTextFromPDF(arrayBuffer) {
        const loadingTask = pdfjsLib.getDocument({
            data: arrayBuffer.slice(0), // pdf.js may take ownership of the buffer, so give it a copy
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            disableFontFace: true,
            isEvalSupported: false, // hardening against CVE-2024-4367
        });

        const pdf = await loadingTask.promise;
        const textContents = [];

        for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
            try {
                const page = await pdf.getPage(pageIndex);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(" ").replace(/\s+/g, " ").trim();
                textContents.push(pageText);
                page.cleanup();
            } catch (e) {
                console.warn(`Could not extract text for page ${pageIndex}; keeping it.`, e);
                textContents.push(null);
            }
        }

        await loadingTask.destroy();
        return textContents;
    }

    async function downloadPDF(file) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const response = await fetch(file.download, { signal: controller.signal, credentials: "same-origin" });
            if (!response.ok) throw new Error(`Error fetching: ${file.filename} (HTTP ${response.status})`);
            return await response.arrayBuffer();
        } catch (e) {
            if (e.name === "AbortError") throw new Error(`Network timeout for: ${file.filename}`);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    async function downloadAndMergePDFs(files) {
        const bookName = getBookName();
        updateProgressUI("Starting process...", 0, files.length);

        try {
            const mergedPdf = await PDFLib.PDFDocument.create();
            // Chapter PDFs overlap at their boundaries (the last page of one chapter
            // is often the first page of the next). Only compare against the
            // previous file so identical-looking pages elsewhere in the book survive.
            let previousHashes = new Set();
            let processedCount = 0;

            for (const file of files) {
                updateProgressUI(`Processing: ${truncateString(file.filename, 30)}`, processedCount + 1, files.length);

                const pdfArrayBuffer = await downloadPDF(file);
                const textContents = await extractTextFromPDF(pdfArrayBuffer);
                const pdfDoc = await PDFLib.PDFDocument.load(pdfArrayBuffer, { ignoreEncryption: true });

                const currentHashes = new Set();
                const pagesToCopy = [];
                for (let i = 0; i < pdfDoc.getPageCount(); i++) {
                    const text = textContents[i];
                    // Blank / image-only pages (no text) are always kept.
                    if (text) {
                        const hash = await sha256Hex(text);
                        currentHashes.add(hash);
                        if (previousHashes.has(hash)) continue;
                    }
                    pagesToCopy.push(i);
                }

                const copiedPages = await mergedPdf.copyPages(pdfDoc, pagesToCopy);
                copiedPages.forEach(page => mergedPdf.addPage(page));

                previousHashes = currentHashes;
                processedCount++;

                await new Promise(resolve => setTimeout(resolve, 150));
            }

            updateProgressUI("Generating final PDF... (This may take a moment)", processedCount, files.length);

            const mergedPdfBytes = await mergedPdf.save({ useObjectStreams: false });
            const mergedBlob = new Blob([mergedPdfBytes], { type: "application/pdf" });

            const downloadUrl = URL.createObjectURL(mergedBlob);
            const a = document.createElement("a");
            a.href = downloadUrl;
            a.download = `${bookName}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            // Revoking immediately can cancel the download in some browsers.
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);

            updateProgressUI("Download complete!", processedCount, files.length);
            await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
            alert("An error occurred while downloading:\n" + error.message);
            console.error("Error details:", error);
        } finally {
            removeProgressUI();
        }
    }

    async function downloadAllPdfs() {
        if (busy) return;

        const pdfs = [];
        findAllInShadow(document, "t-toc-entry").forEach(el => {
            const url = resolvePdfUrl(el.getAttribute("pdf-link"));
            if (!url) return;
            const title = el.getAttribute("title") || "Untitled";
            pdfs.push({
                download: url,
                filename: String(pdfs.length + 1).padStart(3, "0") + "_" + title + ".pdf",
            });
        });

        if (pdfs.length === 0) {
            alert("Couldn't find any pdfs to download!");
            return;
        }

        busy = true;
        setButtonBusy(true);
        try {
            createProgressUI();
            await downloadAndMergePDFs(pdfs);
        } finally {
            busy = false;
            setButtonBusy(false);
        }
    }

    // ---------- Button ----------

    function createButtonHost() {
        const host = document.createElement('div');
        host.id = 'pdf-download-all-btn';
        host.style.cssText = `
            all: initial !important;
            position: absolute !important;
            top: 12px !important;
            right: 66px !important;
            z-index: 999999 !important;
        `;

        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            button {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 9px 16px;
                background: #2563eb;
                color: #ffffff;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s ease, transform 0.1s ease;
            }
            button:hover { background: #1d4ed8; }
            button:active { background: #1e40af; transform: scale(0.97); }
            button:disabled { background: #64748b; cursor: progress; transform: none; }
            button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
            svg { width: 16px; height: 16px; flex-shrink: 0; }
        </style>
        <button type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>Download all</span>
        </button>
        `;

        shadow.querySelector('button').addEventListener('click', downloadAllPdfs);
        return host;
    }

    const btnHost = createButtonHost();
    const btn = btnHost.shadowRoot.querySelector('button');
    const btnLabel = btnHost.shadowRoot.querySelector('span');

    function setButtonBusy(isBusy) {
        btn.disabled = isBusy;
        btnLabel.textContent = isBusy ? "Downloading..." : "Download all";
    }

    let observedDialog = null;
    let dialogObserver = null;

    function syncButton() {
        if (!observedDialog) return;
        if (!observedDialog.contains(btnHost)) {
            observedDialog.appendChild(btnHost);
        }
        btnHost.style.setProperty('display', observedDialog.hasAttribute('open') ? 'block' : 'none', 'important');
    }

    // The dialog lives in a shadow root and may be (re)created by the site at
    // any time, so check for it periodically and re-attach to a new instance.
    function attachToDialog() {
        const dialogEl = findPdfDialog();
        if (!dialogEl) return;
        if (dialogEl !== observedDialog) {
            dialogObserver?.disconnect();
            observedDialog = dialogEl;
            dialogObserver = new MutationObserver(syncButton);
            dialogObserver.observe(dialogEl, { attributes: true, attributeFilter: ['open'], childList: true });
        }
        syncButton();
    }

    attachToDialog();
    setInterval(attachToDialog, 1000);
})();
