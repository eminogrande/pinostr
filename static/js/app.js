document.addEventListener('DOMContentLoaded', async () => {
    const gridContainer = document.getElementById('photo-grid-container');
    if (!gridContainer) {
        console.error('Grid container not found!');
        return;
    }

    if (!window.NostrTools) {
        console.error('NostrTools library not found. Make sure it is loaded.');
        gridContainer.innerHTML = '<p style="color:red;">Error: NostrTools library not found.</p>';
        return;
    }

    const { SimplePool, nip19 } = window.NostrTools;

    const relays = [
        'wss://relay.damus.io',
        'wss://relay.primal.net',
        'wss://nos.lol',
        'wss://nostr.wine',
        'wss://relay.nostr.band' // Added another relay
    ];

    const pool = new SimplePool({ eoseSubTimeout: 10000 }); // Added timeout for EOSE
    const metadataCache = new Map();
    let isLoadingMore = false;
    let oldestTimestamp = Math.floor(Date.now() / 1000);
    let allLoadedEvents = new Set(); // To keep track of loaded event IDs and prevent duplicates

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

    function createPostCard(post) {
        const card = document.createElement('div');
        card.className = 'post-card';

        const img = document.createElement('img');
        img.className = 'main-image';
        img.src = post.imageUrl;
        img.alt = 'Nostr Post Image';
        img.onerror = () => {
            img.alt = 'Image failed to load';
            card.style.display = 'none'; 
        };

        const contentDiv = document.createElement('div');
        contentDiv.className = 'content';

        const textP = document.createElement('p');
        textP.className = 'text-content';
        textP.textContent = post.text.length > 150 ? post.text.substring(0, 147) + '...' : post.text;

        contentDiv.appendChild(textP);

        const publisherDiv = document.createElement('div');
        publisherDiv.className = 'publisher-info';

        const iconImg = document.createElement('img');
        iconImg.className = 'icon';
        iconImg.src = post.publisherIconUrl || 'https://via.placeholder.com/30.png?text=N';
        iconImg.alt = post.publisherName || 'Unknown';
        iconImg.onerror = () => {
            iconImg.src = 'https://via.placeholder.com/30.png?text=N';
            iconImg.alt = 'Icon load error';
        };

        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = post.publisherName || (post.publisherNpub ? post.publisherNpub.substring(0, 10) + '...' : 'Anonymous');

        publisherDiv.appendChild(iconImg);
        publisherDiv.appendChild(nameSpan);

        card.appendChild(img);
        card.appendChild(contentDiv);
        card.appendChild(publisherDiv);

        return card;
    }

    async function fetchMetadata(pubkey) {
        if (metadataCache.has(pubkey)) {
            return metadataCache.get(pubkey);
        }
        try {
            // Only fetch if not in cache to avoid console errors on multiple quick requests for same new pubkey
            if (!pool.subs.some(sub => sub.filters && sub.filters.some(f => f.authors && f.authors.includes(pubkey) && f.kinds && f.kinds.includes(0)))) {
                 const metadataEvent = await pool.get(relays, { kinds: [0], authors: [pubkey] });
                 if (metadataEvent) {
                    const metadata = JSON.parse(metadataEvent.content);
                    metadataCache.set(pubkey, metadata);
                    return metadata;
                }
            }
        } catch (error) {
            // console.warn(`Failed to fetch metadata for ${pubkey}:`, error); // Less noisy
        }
        return null; // Return null if not found or error
    }
    
    let initialLoadComplete = false;

    async function loadMorePosts(isInitialLoad = false) {
        if (isLoadingMore) return;
        isLoadingMore = true;

        if (isInitialLoad) {
            gridContainer.innerHTML = '<p>Loading initial posts...</p>';
            allLoadedEvents.clear(); // Clear for a fresh load
        } else {
            // Optional: Add a small loading indicator at the bottom
            let loadingIndicator = document.getElementById('loading-indicator');
            if (!loadingIndicator) {
                loadingIndicator = document.createElement('p');
                loadingIndicator.id = 'loading-indicator';
                loadingIndicator.textContent = 'Loading more posts...';
                gridContainer.insertAdjacentElement('afterend', loadingIndicator);
            }
            loadingIndicator.style.display = 'block';
        }

        const limit = isInitialLoad ? 40 : 20; // Fetch more on initial load to ensure we get enough with images
        const currentOldestTimestamp = oldestTimestamp; // Capture timestamp before new fetch

        try {
            const events = await pool.list(relays, [{ kinds: [1], limit: limit, until: currentOldestTimestamp }]);
            
            if (isInitialLoad && events.length === 0) {
                 gridContainer.innerHTML = '<p>No posts found. Try different relays or check back later.</p>';
                 isLoadingMore = false;
                 return;
            }
            if (isInitialLoad) {
                gridContainer.innerHTML = ''; // Clear "Loading initial posts..."
            }

            let postsAddedInBatch = 0;
            let tempOldestInBatch = currentOldestTimestamp;

            for (const event of events) {
                if (allLoadedEvents.has(event.id)) continue; // Skip duplicates

                const imageUrl = extractImageUrlFromContent(event.content);
                if (imageUrl) {
                    const metadata = await fetchMetadata(event.pubkey);
                    const publisherNpub = nip19.npubEncode(event.pubkey);

                    const postData = {
                        imageUrl: imageUrl,
                        text: event.content.replace(/!\[.*?\]\(.*?\)|(https?:\/\/[^\s]+)/g, '').trim(),
                        publisherName: metadata?.name || metadata?.display_name || metadata?.username,
                        publisherIconUrl: metadata?.picture,
                        publisherNpub: publisherNpub
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
            
            // Update global oldestTimestamp only if we actually processed events from this batch
            if (events.length > 0) {
                oldestTimestamp = tempOldestInBatch;
            }

            if (isInitialLoad && postsAddedInBatch === 0) {
                gridContainer.innerHTML = '<p>No posts with images found in recent notes. Scroll down to try loading older ones or try again later.</p>';
            }
            
            if (!isInitialLoad && postsAddedInBatch === 0 && events.length > 0) {
                // Fetched events, but none had images. Try fetching even older ones.
                console.log("No new image posts in this batch, trying older...");
                isLoadingMore = false; // Allow immediate re-fetch
                // To prevent infinite loops if there are truly no more image posts, add a counter or a delay.
                // For now, just allowing it for one more quick try.
                if (document.documentElement.scrollHeight <= window.innerHeight) { // If no scrollbar, try to fill
                    loadMorePosts(false);
                }
            }


        } catch (error) {
            console.error("Error loading posts:", error);
            if (isInitialLoad) {
                gridContainer.innerHTML = '<p style="color:red;">Error loading posts. Check console.</p>';
            }
        } finally {
            isLoadingMore = false;
            initialLoadComplete = true;
            let loadingIndicator = document.getElementById('loading-indicator');
            if (loadingIndicator) loadingIndicator.style.display = 'none';
        }
    }

    // Scroll event listener for endless scrolling
    window.addEventListener('scroll', () => {
        // Only trigger if initial load is done and not currently loading
        if (!initialLoadComplete || isLoadingMore) return;

        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) { // 500px threshold
            console.log("Reached bottom, loading more posts...");
            loadMorePosts(false);
        }
    });

    // Initial load
    loadMorePosts(true);
});
