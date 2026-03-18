import {
	VIDEO_ID_REGEX,
} from 'src/constants';
import {
	ThumbnailQuality,
	TranscriptLine,
	TranscriptResponse,
} from 'src/types';
import { requestUrl } from 'obsidian';

/** Represents a single caption track from YouTube's player API */
interface CaptionTrack {
	languageCode: string;
	baseUrl: string;
	name?: {
		runs?: Array<{ text: string }>;
	};
}

/** Represents the captions section in YouTube's player API response */
interface CaptionsData {
	captionTracks: CaptionTrack[];
}

/** Represents YouTube's player API response */
interface PlayerData {
	videoDetails?: {
		title?: string;
		author?: string;
		channelId?: string;
	};
	captions?: {
		playerCaptionsTracklistRenderer?: CaptionsData;
	};
	playabilityStatus?: {
		status?: string;
		reason?: string;
	};
}

/**
 * Service class for interacting with YouTube videos.
 * Provides methods to fetch video thumbnails and transcripts.
 * Uses the same approach as youtube-transcript-api (Python library).
 */
export class YouTubeService {
	private static readonly INNERTUBE_PLAYER_BASE_URL = `https://www.youtube.com/youtubei/v1/player`;
	private static readonly WATCH_URL = `https://www.youtube.com/watch?v=`;

	/**
	 * Default InnerTube client configuration.
	 *
	 * These values were last verified against YouTube's API on 2026-03-17
	 * and match the values used by youtube-transcript-api (Python).
	 *
	 * If requests start failing with 400/403 errors or unexpected behavior,
	 * update DEFAULT_CLIENT_VERSION to the latest YouTube Android app version.
	 * Reference: https://github.com/jdepoix/youtube-transcript-api
	 */
	private static readonly DEFAULT_CLIENT_VERSION = "20.10.38";

	// Mutable copy that can be overridden at runtime if needed.
	private static clientVersion: string = YouTubeService.DEFAULT_CLIENT_VERSION;

	/**
	 * Configure the InnerTube client version used for YouTube API requests.
	 * This allows updating the value without changing the source code if
	 * YouTube deprecates the pinned default.
	 */
	public static configureClient(options: {
		clientVersion?: string;
		androidSdkVersion?: number;
	}): void {
		if (typeof options.clientVersion === "string" && options.clientVersion.trim().length > 0) {
			YouTubeService.clientVersion = options.clientVersion.trim();
		}
	}

	// Use ANDROID client like youtube-transcript-api does - it's less restricted
	private static get INNERTUBE_CONTEXT() {
		return {
			client: {
				clientName: "ANDROID",
				clientVersion: YouTubeService.clientVersion,
			},
		};
	}
	/**
	 * Gets the thumbnail URL for a YouTube video
	 * @param videoId - The YouTube video identifier
	 * @param quality - Desired thumbnail quality (default: 'maxres')
	 * @returns URL string for the video thumbnail
	 */
	static getThumbnailUrl(
		videoId: string,
		quality: keyof ThumbnailQuality = 'maxres'
	): string {
		const qualities: ThumbnailQuality = {
			default: `https://img.youtube.com/vi/${videoId}/default.jpg`,
			medium: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
			high: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
			standard: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
			maxres: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
		};
		return qualities[quality];
	}

	/**
	 * Checks if a URL is a valid YouTube URL
	 * @param url - The URL to check
	 * @returns True if the URL is a YouTube URL, false otherwise
	 */
	static isYouTubeUrl(url: string): boolean {
		return (
			url.startsWith('https://www.youtube.com/') ||
			url.startsWith('https://youtu.be/')
		);
	}

	/**
	 * Fetches and processes a YouTube video transcript using the player API approach
	 * This mimics how youtube-transcript-api (Python) works:
	 * 1. Fetch player data with ANDROID client to get caption tracks
	 * 2. Fetch transcript directly from caption track baseUrl
	 *
	 * @param url - Full YouTube video URL
	 * @param langCode - Language code for caption track (default: 'en')
	 * @returns Promise containing video metadata and transcript
	 * @throws Error if transcript cannot be fetched or processed
	 */
	async fetchTranscript(
		url: string,
		langCode = 'en'
	): Promise<TranscriptResponse> {
		try {
			// Extract video ID from URL
			const videoId = this.extractMatch(url, VIDEO_ID_REGEX);
			if (!videoId) throw new Error('Invalid YouTube URL');

			console.debug(`Fetching transcript for video: ${videoId}`);

			// Step 1: Fetch player data to get caption tracks
			const playerData = await this.fetchPlayerData(videoId);

			// Extract video metadata
			const title = playerData.videoDetails?.title || 'Unknown';
			const author = playerData.videoDetails?.author || 'Unknown';
			const channelId = playerData.videoDetails?.channelId || '';

			// Step 2: Get caption tracks
			const captionsData = playerData.captions?.playerCaptionsTracklistRenderer;
			if (!captionsData || !captionsData.captionTracks) {
				throw new Error('No captions available for this video');
			}

			// Step 3: Find the best matching caption track
			const captionTrack = this.findCaptionTrack(captionsData.captionTracks, langCode);
			if (!captionTrack) {
				const availableLangs = captionsData.captionTracks.map((t: CaptionTrack) => t.languageCode).join(', ');
				throw new Error(`No transcript found for language '${langCode}'. Available: ${availableLangs}`);
			}

			console.debug(`Found caption track: ${captionTrack.name?.runs?.[0]?.text || captionTrack.languageCode}`);

			// Step 4: Fetch the actual transcript from the caption URL
			const transcriptUrl = captionTrack.baseUrl;
			const lines = await this.fetchTranscriptFromUrl(transcriptUrl);

			return {
				url,
				videoId,
				title: this.decodeHTML(title),
				author: this.decodeHTML(author),
				channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : '',
				lines,
			};
		} catch (error: unknown) {
			throw new Error(`Failed to fetch transcript: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Extracts the InnerTube API key dynamically from a YouTube watch page.
	 * This avoids relying on a hardcoded key that YouTube may invalidate.
	 */
	private async fetchInnertubeApiKey(videoId: string): Promise<string> {
		const watchResponse = await requestUrl({
			url: `${YouTubeService.WATCH_URL}${videoId}`,
			method: "GET",
			headers: {
				"Accept-Language": "en-US,en;q=0.9",
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			},
		});

		const match = watchResponse.text.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
		if (match && match[1]) {
			return match[1];
		}

		// Fallback: use a well-known public key if extraction fails
		return "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
	}

	/**
	 * Fetches player data from YouTube's InnerTube API.
	 * Dynamically extracts the API key from the watch page each time.
	 */
	private async fetchPlayerData(videoId: string): Promise<PlayerData> {
		const apiKey = await this.fetchInnertubeApiKey(videoId);

		const requestBody = {
			context: YouTubeService.INNERTUBE_CONTEXT,
			videoId: videoId,
		};

		const response = await requestUrl({
			url: `${YouTubeService.INNERTUBE_PLAYER_BASE_URL}?key=${apiKey}`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": `com.google.android.youtube/${YouTubeService.clientVersion} (Linux; U; Android 11) gzip`,
			},
			body: JSON.stringify(requestBody),
		});

		let data: PlayerData;
		try {
			data = JSON.parse(response.text) as PlayerData;
		} catch (error) {
			throw new Error(
				`Failed to parse YouTube player data JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		// Check playability status
		const playabilityStatus = data.playabilityStatus;
		if (playabilityStatus) {
			if (playabilityStatus.status === 'ERROR') {
				throw new Error(playabilityStatus.reason || 'Video unavailable');
			}
			if (playabilityStatus.status === 'LOGIN_REQUIRED') {
				throw new Error('This video requires login to view');
			}
			if (playabilityStatus.status === 'UNPLAYABLE') {
				throw new Error(playabilityStatus.reason || 'Video is unplayable');
			}
		}

		return data;
	}

	/**
	 * Finds the best matching caption track for the requested language
	 */
	private findCaptionTrack(captionTracks: CaptionTrack[], langCode: string): CaptionTrack | null {
		// First try exact match
		let track = captionTracks.find((t: CaptionTrack) => t.languageCode === langCode);
		if (track) return track;

		// Try matching language prefix (e.g., 'en' matches 'en-US')
		track = captionTracks.find((t: CaptionTrack) => t.languageCode.startsWith(langCode + '-'));
		if (track) return track;

		// Try finding track where requested lang is a prefix (e.g., 'en-US' when looking for 'en')
		track = captionTracks.find((t: CaptionTrack) => langCode.startsWith(t.languageCode + '-'));
		if (track) return track;

		// Fall back to first available track
		if (captionTracks.length > 0) {
			console.debug(`Language '${langCode}' not found, falling back to '${captionTracks[0].languageCode}'`);
			return captionTracks[0];
		}

		return null;
	}

	/**
	 * Fetches transcript XML from the caption track URL
	 */
	private async fetchTranscriptFromUrl(transcriptUrl: string): Promise<TranscriptLine[]> {
		const response = await requestUrl({
			url: transcriptUrl,
			method: "GET",
			headers: {
				"Accept-Language": "en-US,en;q=0.9",
			},
		});

		return this.parseTranscriptXml(response.text);
	}

	/**
	 * Parses the transcript XML response into structured format
	 */
	private parseTranscriptXml(xmlContent: string): TranscriptLine[] {
		const lines: TranscriptLine[] = [];

		// Parse XML manually (Obsidian doesn't have DOMParser in all contexts)
		// YouTube uses two different formats:
		// Format 1: <text start="0.0" dur="1.54">Hey there</text>
		// Format 2: <p t="1360" d="1680">Text here</p>

		// Try format 2 first (newer format with <p> tags, times in milliseconds)
		// Match entire <p> tag without assuming attribute order
		const pTagRegex = /<p\s+([^>]+)>([\s\S]*?)<\/p>/g;
		let match;

		while ((match = pTagRegex.exec(xmlContent)) !== null) {
			const attributes = match[1];
			const content = match[2];

			// Extract t and d attributes independently
			const tMatch = attributes.match(/\bt="(\d+)"/);
			const dMatch = attributes.match(/\bd="(\d+)"/);

			if (tMatch && dMatch) {
				const start = parseInt(tMatch[1]); // Already in milliseconds
				const duration = parseInt(dMatch[1]);
				const text = this.decodeHTML(content.replace(/<[^>]+>/g, ' ')); // Strip any inner tags

				if (text.trim()) {
					lines.push({
						text: text.trim(),
						offset: start,
						duration,
					});
				}
			}
		}

		// If no matches with <p> format, try <text> format (times in seconds)
		if (lines.length === 0) {
			// Match entire <text> tag without assuming attribute order
			const textRegex = /<text\s+([^>]+)>([\s\S]*?)<\/text>/g;

			while ((match = textRegex.exec(xmlContent)) !== null) {
				const attributes = match[1];
				const content = match[2];

				// Extract start and dur attributes independently
				const startMatch = attributes.match(/\bstart="([^"]+)"/);
				const durMatch = attributes.match(/\bdur="([^"]+)"/);

				if (startMatch && durMatch) {
					const start = parseFloat(startMatch[1]) * 1000; // Convert to milliseconds
					const duration = parseFloat(durMatch[1]) * 1000;
					const text = this.decodeHTML(content.replace(/<[^>]+>/g, ' '));

					if (text.trim()) {
						lines.push({
							text: text.trim(),
							offset: start,
							duration,
						});
					}
				}
			}
		}

		if (lines.length === 0) {
			throw new Error('Failed to parse transcript XML - no caption segments found');
		}

		return lines;
	}

	/**
	 * Extracts the first match of a regex pattern from a string
	 * @param text - The text to search within
	 * @param regex - The regex pattern to match
	 * @returns The first match or null if not found
	 */
	private extractMatch(text: string, regex: RegExp): string | null {
		const match = text.match(regex);
		return match ? match[1] : null;
	}

	/**
	 * Decodes HTML entities in a text string
	 *
	 * @param text - Text string with HTML entities
	 * @returns Decoded text string
	 */
	private decodeHTML(text: string): string {
		return text
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
			.replace(/\\n/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}
}
