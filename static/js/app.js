document.addEventListener('DOMContentLoaded', async () => {
    const gridContainer = document.getElementById('photo-grid-container');
    const zapFilterCheckbox = document.getElementById('zap-filter');
    const bitcoinFilterToggle = document.getElementById('bitcoin-filter-toggle');

    if (!gridContainer) {
        console.error('Grid container not found!');
        return;
    }
    if (!zapFilterCheckbox) {
        console.warn('Zap filter checkbox not found! Zap filtering may not work.');
    }
    if (!bitcoinFilterToggle) {
        console.warn('Bitcoin filter toggle not found! Bitcoin filtering may not work.');
    }

    if (!window.NostrTools) {
        console.error('NostrTools library not found. Make sure it is loaded.');
        gridContainer.innerHTML = '<p style="color:red;">Error: NostrTools library not found.</p>';
        return;
    }

    const { SimplePool, nip19, utils } = window.NostrTools;

    const relays = [
        'wss://relay.damus.io',
        'wss://relay.primal.net',
        'wss://nos.lol',
        'wss://nostr.wine',
        'wss://relay.nostr.band'
    ];

    const pool = new SimplePool({ eoseSubTimeout: 10000 });
    const metadataCache = new Map();
    let isLoadingMore = false;
    let oldestTimestamp = Math.floor(Date.now() / 1000);
    let allLoadedEvents = new Set();
    
    let zapFilterActive = false; 
    const MIN_ZAP_AMOUNT_SATS = 1; 
    let bitcoinFilterActive = false;

    function isValidImageUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const parsedUrl = new URL(url);
            return /\.(jpeg|jpg|gif|png|webp)$/i.test(parsedUrl.pathname);
        } catch (e) {
            return false;
        }
    }

    function extractImageUrlFromContent(content) {
        if (!content) return null;
        const markdownMatch = content.match(/!\[.*?\]\((.*?)\)/);
        if (markdownMatch && markdownMatch[1] && isValidImageUrl(markdownMatch[1])) {
            return markdownMatch[1];
        }
        const urlRegex = /(https|http):\/\/[^\s]+\.(jpeg|jpg|gif|png|webp)/gi;
        const urls = content.match(urlRegex);
        if (urls) {
            for (const url of urls) {
                if (isValidImageUrl(url)) return url;
            }
        }
        return null;
    }

    function checkZapAmountsForNote(noteId, zapEventsForNote, minAmountMillisats) {
        if (!zapEventsForNote || zapEventsForNote.length === 0) return false;
        for (const zapEvent of zapEventsForNote) {
            const amountTag = zapEvent.tags.find(tag => tag[0] === 'amount');
            if (amountTag && amountTag[1]) {
                const amountMillisats = parseInt(amountTag[1], 10);
                if (!isNaN(amountMillisats) && amountMillisats >= minAmountMillisats) return true;
            }
        }
        return false; 
    }

    function createPostCard(post) { 
        const card = document.createElement('div');
        card.className = 'post-card';
        if (post.hasMinimumZap) card.dataset.hasZaps = 'true';
        if (post.isBitcoinPost) card.dataset.isBitcoin = 'true';

        const imageLink = document.createElement('a');
        try {
            const nEvent = nip19.neventEncode({ id: post.noteId, relays: relays.slice(0,2) });
            imageLink.href = `https://primal.net/e/${nEvent}`;
        } catch (e) {
            console.warn("Error encoding noteId for primal link:", post.noteId, e);
            imageLink.href = `https://primal.net/e/${post.noteId}`;
        }
        imageLink.target = '_blank'; 
        imageLink.rel = 'noopener noreferrer';

        const imgTag = document.createElement('img'); // Renamed to avoid conflict with 'img' variable name
        imgTag.className = 'main-image'; 
        imgTag.src = post.imageUrl;
        imgTag.alt = 'Nostr Post Image';
        imgTag.onerror = () => {
            imgTag.alt = 'Image failed to load';
            card.style.display = 'none'; 
        };
        imageLink.appendChild(imgTag);

        const imageContainer = document.createElement('div');
        imageContainer.className = 'main-image-container';
        imageContainer.appendChild(imageLink);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'content'; 
        const textP = document.createElement('p');
        textP.className = 'text-content';
        textP.textContent = post.text.length > 150 ? post.text.substring(0, 147) + '...' : post.text;
        contentDiv.appendChild(textP);
        
        const publisherDiv = document.createElement('div');
        publisherDiv.className = 'publisher-info';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = post.publisherName || (post.publisherNpub ? post.publisherNpub.substring(0, 10) + '...' : 'Anonymous');
        publisherDiv.appendChild(nameSpan);

        card.appendChild(imageContainer); 
        card.appendChild(contentDiv); 
        card.appendChild(publisherDiv); 
        return card;
    }

    async function fetchMetadata(pubkeysToFetch) {
        console.log("fetchMetadata: Called with pubkeys:", pubkeysToFetch);
        if (pubkeysToFetch.length === 0) {
            console.log("fetchMetadata: No pubkeys to fetch.");
            return;
        }
        
        const newPubkeys = pubkeysToFetch.filter(pk => {
            const cached = metadataCache.get(pk);
            return !cached || cached.pending || cached.error || cached.notFound; // Re-fetch if error or notFound previously, or still pending
        });

        if (newPubkeys.length === 0) {
            console.log("fetchMetadata: No new pubkeys to fetch (all cached or already pending and valid).");
            return;
        }
        console.log("fetchMetadata: Actual new/refetch pubkeys:", newPubkeys);

        newPubkeys.forEach(pk => metadataCache.set(pk, { pending: true }));
        
        try {
            const metadataEvents = await pool.list(relays, [{ kinds: [0], authors: newPubkeys }]);
            console.log("fetchMetadata: Received metadata events:", metadataEvents.length);
            
            const foundPubkeys = new Set();
            metadataEvents.forEach(event => {
                try {
                    const metadata = JSON.parse(event.content);
                    metadataCache.set(event.pubkey, metadata);
                    foundPubkeys.add(event.pubkey);
                } catch (e) {
                    console.warn(`fetchMetadata: Failed to parse metadata JSON for ${event.pubkey}:`, event.content, e);
                    metadataCache.set(event.pubkey, { error: "Failed to parse" });
                    foundPubkeys.add(event.pubkey); // Still mark as "processed" for this batch
                }
            });

            // For any pubkeys that were requested but no event was returned
            newPubkeys.forEach(pk => {
                if (!foundPubkeys.has(pk)) { // If not found in the events from this fetch
                    console.log(`fetchMetadata: No metadata event found for ${pk}. Marking as notFound.`);
                    metadataCache.set(pk, { notFound: true });
                }
            });

        } catch (error) {
            console.error("fetchMetadata: Error fetching metadata for new pubkeys:", newPubkeys, error);
            newPubkeys.forEach(pk => metadataCache.set(pk, { error: "Fetch failed" }));
        }
        console.log("fetchMetadata: Exiting. Cache state:", metadataCache);
    }
    
    let initialLoadComplete = false;
    let statusMessageElement = null; 
    const statusMessageContainer = document.getElementById('loading-indicator-container');

    async function loadMorePosts(isInitialLoad = false) {
        console.log(`loadMorePosts: Called. isInitialLoad: ${isInitialLoad}, isLoadingMore: ${isLoadingMore}`);
        if (isLoadingMore) return;
        isLoadingMore = true;
        
        if (!statusMessageElement && statusMessageContainer) {
            statusMessageElement = document.createElement('p');
            statusMessageElement.id = 'status-message';
            statusMessageContainer.appendChild(statusMessageElement);
        } else if (!statusMessageElement && !statusMessageContainer && isInitialLoad) {
            statusMessageElement = document.createElement('p');
            statusMessageElement.id = 'status-message';
            gridContainer.insertAdjacentElement('beforebegin', statusMessageElement);
        }

        if (isInitialLoad) {
            gridContainer.innerHTML = ''; 
            if(statusMessageElement) statusMessageElement.textContent = 'Loading initial posts...';
            allLoadedEvents.clear();
        } else {
            if(statusMessageElement) statusMessageElement.textContent = 'Loading more posts...';
        }
        if(statusMessageElement) statusMessageElement.style.display = 'block';

        const limit = isInitialLoad ? 40 : 20;
        const currentOldestTimestamp = oldestTimestamp;

        try {
            console.log("loadMorePosts: Fetching note events (kind 1)...");
            const noteEvents = await pool.list(relays, [{ kinds: [1], limit: limit, until: currentOldestTimestamp }]);
            console.log('loadMorePosts: Fetched note events:', noteEvents ? noteEvents.length : 'null');
            
            if (isInitialLoad && (!noteEvents || noteEvents.length === 0) ) {
                 console.log('loadMorePosts: No note events found on initial load.');
                 if(statusMessageElement) statusMessageElement.textContent = 'No posts found. Try different relays or check back later.';
                 isLoadingMore = false;
                 return; 
            }
            
            if (statusMessageElement && noteEvents && (noteEvents.length > 0 || !isInitialLoad) ) {
                 statusMessageElement.textContent = ''; 
                 statusMessageElement.style.display = 'none'; 
            }

            const noteIds = noteEvents.map(event => event.id);
            console.log('loadMorePosts: Note IDs for zap/metadata fetching:', noteIds);
            let zapEventsMap = new Map(); 

            if (noteIds.length > 0) {
                console.log("loadMorePosts: Fetching zap events (kind 9735)...");
                const zapReceiptEvents = await pool.list(relays, [{ kinds: [9735], "#e": noteIds }]);
                console.log('loadMorePosts: Fetched zap events:', zapReceiptEvents ? zapReceiptEvents.length : 'null');
                if(zapReceiptEvents) {
                    zapReceiptEvents.forEach(zapEvent => {
                        const zappedNoteIdTag = zapEvent.tags.find(tag => tag[0] === 'e' && tag[1] && noteIds.includes(tag[1]));
                        if (zappedNoteIdTag) {
                            const zappedNoteId = zappedNoteIdTag[1];
                            if (!zapEventsMap.has(zappedNoteId)) zapEventsMap.set(zappedNoteId, []);
                            zapEventsMap.get(zappedNoteId).push(zapEvent);
                        }
                    });
                }
            }
            
            const pubkeysToFetch = [...new Set(noteEvents.map(event => event.pubkey))]; // No longer pre-filtering based on cache here for simplicity in logging fetchMetadata call
            console.log('loadMorePosts: Calling fetchMetadata for pubkeys:', pubkeysToFetch);
            await fetchMetadata(pubkeysToFetch);
            console.log('loadMorePosts: fetchMetadata completed.');


            let postsAddedInBatch = 0;
            let tempOldestInBatch = currentOldestTimestamp;

            console.log('loadMorePosts: Processing ', noteEvents.length, ' note events for card creation...');
            for (const event of noteEvents) {
                if (allLoadedEvents.has(event.id)) {
                    console.log('loadMorePosts: Skipping duplicate event:', event.id);
                    continue;
                }

                const imageUrl = extractImageUrlFromContent(event.content);
                console.log('loadMorePosts: Processing event:', event.id, 'Has image:', !!imageUrl);

                if (imageUrl) {
                    const metadata = metadataCache.get(event.pubkey) || { notFound: true }; // Ensure metadata is an object
                    const publisherNpub = nip19.npubEncode(event.pubkey);
                    const zapsForThisNote = zapEventsMap.get(event.id) || [];
                    const hasMinZap = checkZapAmountsForNote(event.id, zapsForThisNote, MIN_ZAP_AMOUNT_SATS * 1000);
                    
                    const contentLowerCase = event.content ? event.content.toLowerCase() : "";
                    const tags = event.tags || [];
                    const isBitcoinRelated = contentLowerCase.includes('bitcoin') || 
                                             contentLowerCase.includes('#bitcoin') || 
                                             tags.some(tag => tag[0] === 't' && tag[1] && tag[1].toLowerCase() === 'bitcoin');

                    const postData = {
                        noteId: event.id, 
                        imageUrl: imageUrl,
                        text: event.content.replace(/!\[.*?\]\(.*?\)|(https?:\/\/[^\s]+)/g, '').trim(),
                        publisherName: metadata?.name || metadata?.display_name || metadata?.username,
                        publisherNpub: publisherNpub,
                        hasMinimumZap: hasMinZap, 
                        isBitcoinPost: isBitcoinRelated
                    };
                    
                    const postElement = createPostCard(postData);
                    if (postElement) {
                       gridContainer.appendChild(postElement); 
                       console.log('loadMorePosts: Appended post card for event:', event.id);
                       postsAddedInBatch++;
                       allLoadedEvents.add(event.id);
                    }
                }
                if (event.created_at < tempOldestInBatch) {
                    tempOldestInBatch = event.created_at;
                }
            }
            
            if (noteEvents.length > 0) {
                oldestTimestamp = tempOldestInBatch;
            }

            if (isInitialLoad && postsAddedInBatch === 0 && statusMessageElement) {
                 statusMessageElement.textContent = 'No posts with images found in recent notes. Scroll to load older or try filters.';
                 statusMessageElement.style.display = 'block';
            }
            
        } catch (error) {
            console.error("loadMorePosts: Full error in loadMorePosts:", error);
            if (statusMessageElement) {
                statusMessageElement.textContent = 'Error loading posts. Check console.';
                statusMessageElement.style.color = 'red';
                statusMessageElement.style.display = 'block';
            } else if (isInitialLoad) { 
                 gridContainer.innerHTML = '<p style="color:red;">Error loading posts. Check console.</p>';
            }
        } finally {
            isLoadingMore = false;
            initialLoadComplete = true;
            if (statusMessageElement && statusMessageElement.textContent === 'Loading more posts...') {
                 statusMessageElement.textContent = '';
                 statusMessageElement.style.display = 'none';
            }
            console.log("loadMorePosts: Calling applyFilters in finally block.");
            applyFilters(); 
        }
    }

    function applyFilters() {
        console.log('applyFilters: Applying filters. Zap active:', zapFilterActive, 'Bitcoin active:', bitcoinFilterActive);
        const cards = gridContainer.querySelectorAll('.post-card');
        cards.forEach(card => {
            let showCard = true; 
            if (zapFilterActive && card.dataset.hasZaps !== 'true') showCard = false;
            if (bitcoinFilterActive && card.dataset.isBitcoin !== 'true') showCard = false;
            card.style.display = showCard ? '' : 'none'; 
        });
        console.log('applyFilters: Filtering complete.');
    }
    
    if (zapFilterCheckbox) {
        zapFilterCheckbox.addEventListener('change', (event) => {
            zapFilterActive = event.target.checked;
            applyFilters();
        });
    }

    if (bitcoinFilterToggle) {
        bitcoinFilterToggle.addEventListener('change', (event) => {
            bitcoinFilterActive = event.target.checked;
            applyFilters();
        });
    }

    window.addEventListener('scroll', () => {
        if (!initialLoadComplete || isLoadingMore) return;
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
            console.log("Window scroll: Reached bottom, calling loadMorePosts(false).");
            loadMorePosts(false);
        }
    });

    console.log("DOMContentLoaded: Initializing. Calling loadMorePosts(true).");
    loadMorePosts(true);
});
