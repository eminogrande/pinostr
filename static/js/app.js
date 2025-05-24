document.addEventListener('DOMContentLoaded', async () => {
    const gridContainer = document.getElementById('photo-grid-container');
    const zapFilterCheckbox = document.getElementById('zap-filter');
    const bitcoinFilterToggle = document.getElementById('bitcoin-filter-toggle'); // Get Bitcoin filter toggle

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

    let bitcoinFilterActive = false; // Bitcoin filter state

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
        if (!zapEventsForNote || zapEventsForNote.length === 0) {
            return false;
        }
        for (const zapEvent of zapEventsForNote) {
            const amountTag = zapEvent.tags.find(tag => tag[0] === 'amount');
            if (amountTag && amountTag[1]) {
                const amountMillisats = parseInt(amountTag[1], 10);
                if (!isNaN(amountMillisats) && amountMillisats >= minAmountMillisats) {
                    return true; 
                }
            }
        }
        return false; 
    }

    function createPostCard(post) { 
        const card = document.createElement('div');
        card.className = 'post-card';
        if (post.hasMinimumZap) {
            card.dataset.hasZaps = 'true';
        }
        if (post.isBitcoinPost) { // Ensure this attribute is set
            card.dataset.isBitcoin = 'true';
        }

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

        const img = document.createElement('img');
        img.className = 'main-image'; 
        img.src = post.imageUrl;
        img.alt = 'Nostr Post Image';
        img.onerror = () => {
            img.alt = 'Image failed to load';
            card.style.display = 'none'; 
        };
        imageLink.appendChild(img);

        const imageContainer = document.createElement('div');
        imageContainer.className = 'main-image-container';
        imageContainer.appendChild(imageLink); // imageLink now goes into imageContainer

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

        card.appendChild(imageContainer); // imageContainer is appended to card
        card.appendChild(contentDiv); 
        card.appendChild(publisherDiv); 

        return card;
    }

    async function fetchMetadata(pubkeysToFetch) {
        if (pubkeysToFetch.length === 0) return;
        const newPubkeys = pubkeysToFetch.filter(pk => !metadataCache.has(pk) || metadataCache.get(pk)?.pending);
        if (newPubkeys.length === 0) return;
        newPubkeys.forEach(pk => metadataCache.set(pk, { pending: true }));
        try {
            const metadataEvents = await pool.list(relays, [{ kinds: [0], authors: newPubkeys }]);
            metadataEvents.forEach(event => {
                try {
                    const metadata = JSON.parse(event.content);
                    metadataCache.set(event.pubkey, metadata);
                } catch (e) {
                    console.warn("Failed to parse metadata JSON for pubkey " + event.pubkey + ":", event.content, e);
                    metadataCache.set(event.pubkey, { error: "Failed to parse" });
                }
            });
        } catch (error) {
            console.error("Failed to fetch metadata for new pubkeys:", error);
            newPubkeys.forEach(pk => metadataCache.set(pk, { error: "Fetch failed" }));
        }
    }
    
    let initialLoadComplete = false;
    let statusMessageElement = null; 
    const statusMessageContainer = document.getElementById('loading-indicator-container');

    async function loadMorePosts(isInitialLoad = false) {
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
            const noteEvents = await pool.list(relays, [{ kinds: [1], limit: limit, until: currentOldestTimestamp }]);
            
            if (isInitialLoad && noteEvents.length === 0 ) {
                 if(statusMessageElement) statusMessageElement.textContent = 'No posts found. Try different relays or check back later.';
                 isLoadingMore = false;
                 return; 
            }
            
            if (statusMessageElement && (noteEvents.length > 0 || !isInitialLoad) ) {
                 statusMessageElement.textContent = ''; 
                 statusMessageElement.style.display = 'none'; 
            }

            const noteIds = noteEvents.map(event => event.id);
            let zapEventsMap = new Map(); 

            if (noteIds.length > 0) {
                const zapReceiptEvents = await pool.list(relays, [{ kinds: [9735], "#e": noteIds }]);
                zapReceiptEvents.forEach(zapEvent => {
                    const zappedNoteIdTag = zapEvent.tags.find(tag => tag[0] === 'e' && tag[1] && noteIds.includes(tag[1]));
                    if (zappedNoteIdTag) {
                        const zappedNoteId = zappedNoteIdTag[1];
                        if (!zapEventsMap.has(zappedNoteId)) {
                            zapEventsMap.set(zappedNoteId, []);
                        }
                        zapEventsMap.get(zappedNoteId).push(zapEvent);
                    }
                });
            }
            
            const pubkeysToFetch = [...new Set(noteEvents.map(event => event.pubkey).filter(pk => !metadataCache.has(pk) || metadataCache.get(pk)?.pending))];
            await fetchMetadata(pubkeysToFetch);

            let postsAddedInBatch = 0;
            let tempOldestInBatch = currentOldestTimestamp;

            for (const event of noteEvents) {
                if (allLoadedEvents.has(event.id)) continue;

                const imageUrl = extractImageUrlFromContent(event.content);
                if (imageUrl) {
                    const metadata = metadataCache.get(event.pubkey);
                    const publisherNpub = nip19.npubEncode(event.pubkey);
                    const zapsForThisNote = zapEventsMap.get(event.id) || [];
                    const hasMinZap = checkZapAmountsForNote(event.id, zapsForThisNote, MIN_ZAP_AMOUNT_SATS * 1000);
                    
                    // Bitcoin related check
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
                        isBitcoinPost: isBitcoinRelated // Store bitcoin status
                    };
                    
                    const postElement = createPostCard(postData);
                    if (postElement) {
                       gridContainer.appendChild(postElement); 
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
            console.error("Error loading posts:", error);
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
            applyFilters(); 
        }
    }

    function applyFilters() {
        const cards = gridContainer.querySelectorAll('.post-card');
        cards.forEach(card => {
            let showCard = true; 

            if (zapFilterActive && card.dataset.hasZaps !== 'true') {
                showCard = false;
            }

            // Bitcoin filter logic
            if (bitcoinFilterActive && card.dataset.isBitcoin !== 'true') {
                showCard = false;
            }
            
            card.style.display = showCard ? '' : 'none'; 
        });
    }
    
    if (zapFilterCheckbox) {
        zapFilterCheckbox.addEventListener('change', (event) => {
            zapFilterActive = event.target.checked;
            applyFilters();
        });
    }

    if (bitcoinFilterToggle) { // Add event listener for Bitcoin filter
        bitcoinFilterToggle.addEventListener('change', (event) => {
            bitcoinFilterActive = event.target.checked;
            applyFilters();
        });
    }

    window.addEventListener('scroll', () => {
        if (!initialLoadComplete || isLoadingMore) return;
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
            loadMorePosts(false);
        }
    });

    // Initial load
    loadMorePosts(true);
});
