#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY || 'MarufRaxmonov/relaxing-audio';
const branch = process.env.AUDIO_BRANCH || process.env.GITHUB_REF_NAME || 'main';
const manifestPath = process.env.AUDIO_MANIFEST_PATH || 'audio-manifest.json';
const audioDirectory = process.env.AUDIO_DIRECTORY || 'audio';
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
    throw new Error('GITHUB_TOKEN topilmadi.');
}

async function githubJson(path) {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${githubToken}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'audio-manifest-sync'
        }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API ${response.status}: ${body}`);
    }

    return response.json();
}

function encodePath(path) {
    return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function rawUrl(path) {
    return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/${encodePath(path)}`;
}

function normalizeVariantId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '');
}

function getVariantLabel(variantId) {
    const knownLabels = {
        original: 'Original',
        echo: 'Echo',
        stadium: 'Stadium'
    };
    if (knownLabels[variantId]) return knownLabels[variantId];
    return variantId
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getSongKey(song) {
    return String(song?.id || song?.name || '').trim();
}

function getAudioFileParts(path) {
    const fileName = path.split('/').pop() || '';
    const extensionIndex = fileName.lastIndexOf('.');
    const baseName = extensionIndex > 0
        ? fileName.slice(0, extensionIndex)
        : fileName;
    const separatorIndex = baseName.lastIndexOf('__');
    if (separatorIndex <= 0 || separatorIndex >= baseName.length - 2) return null;

    const songName = baseName.slice(0, separatorIndex).trim();
    const variantId = normalizeVariantId(baseName.slice(separatorIndex + 2));
    if (!songName || !variantId) return null;

    return {
        fileName,
        songName,
        variantId
    };
}

function isManagedAudioFileName(value) {
    return /^[^/]+__[^/]+\.mp3$/i.test(String(value || '').trim());
}

async function collectLocalAudioFiles(directory, relativeDirectory = '') {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (!relativeDirectory && error.code === 'ENOENT') return null;
        throw error;
    }

    const files = [];
    for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
        if (entry.isDirectory()) {
            files.push(...await collectLocalAudioFiles(fullPath, relativePath));
            continue;
        }
        if (!entry.isFile() || !/\.mp3$/i.test(entry.name)) continue;
        files.push({
            path: `${audioDirectory.replace(/\/+$/, '')}/${relativePath}`,
            size: (await stat(fullPath)).size
        });
    }
    return files;
}

const audioPrefix = `${audioDirectory.replace(/\/+$/, '')}/`;
let audioFiles = await collectLocalAudioFiles(audioDirectory);
if (audioFiles === null) {
    const treeResponse = await githubJson(
        `/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );

    if (treeResponse.truncated) {
        throw new Error('GitHub tree juda katta; audio katalogini alohida olish kerak.');
    }

    audioFiles = (treeResponse.tree || [])
        .filter((item) => (
            item.type === 'blob'
            && item.path.startsWith(audioPrefix)
            && /\.mp3$/i.test(item.path)
        ))
        .map((item) => ({ path: item.path, size: item.size }))
        .sort((left, right) => left.path.localeCompare(right.path));
}

const discoveredTracks = [];
for (const file of audioFiles) {
    const parts = getAudioFileParts(file.path);
    if (!parts) {
        console.warn(`O‘tkazib yuborildi: "${file.path}" (__variant.mp3 formati kerak).`);
        continue;
    }

    const sizeBytes = Number(file.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(`Haqiqiy fayl hajmi GitHub API'dan olinmadi: ${file.path}`);
    }

    discoveredTracks.push({
        ...parts,
        sizeBytes,
        url: rawUrl(file.path)
    });
}

let manifest;
try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
    throw new Error(`${manifestPath} o‘qilmadi: ${error.message}`);
}

let songs = Array.isArray(manifest.songs)
    ? manifest.songs.map((song) => ({ ...song }))
    : [];
let changed = false;
let removedVariantCount = 0;
let removedSongCount = 0;

const discoveredFileNames = new Set(
    discoveredTracks.map((track) => track.fileName)
);

const reconciledSongs = [];
songs.forEach((song) => {
    const currentVariants = Array.isArray(song.variants)
        ? song.variants.map((variant) => ({ ...variant }))
        : [];
    const nextVariants = currentVariants.filter((variant) => (
        !isManagedAudioFileName(variant?.fileName)
        || discoveredFileNames.has(String(variant.fileName).trim())
    ));
    const removedCount = currentVariants.length - nextVariants.length;
    const hadManagedVariants = currentVariants.some((variant) =>
        isManagedAudioFileName(variant?.fileName)
    );

    if (!removedCount) {
        reconciledSongs.push(song);
        return;
    }

    changed = true;
    removedVariantCount += removedCount;
    if (!nextVariants.length && hadManagedVariants) {
        removedSongCount += 1;
        return;
    }

    reconciledSongs.push({
        ...song,
        variants: nextVariants,
        sizeBytes: nextVariants.reduce(
            (total, variant) => total + (Number(variant?.sizeBytes) || 0),
            0
        )
    });
});
songs = reconciledSongs;

const songIndexes = new Map();
songs.forEach((song, index) => {
    const key = getSongKey(song);
    if (key && !songIndexes.has(key)) songIndexes.set(key, index);
});

for (const track of discoveredTracks) {
    let trackChanged = false;
    let songIndex = songIndexes.get(track.songName);
    if (songIndex === undefined) {
        songIndex = songs.length;
        songs.push({
            id: track.songName,
            name: track.songName,
            variants: []
        });
        songIndexes.set(track.songName, songIndex);
        trackChanged = true;
    }

    const song = songs[songIndex];
    const variants = Array.isArray(song.variants)
        ? song.variants.map((variant) => ({ ...variant }))
        : [];
    const existingIndex = variants.findIndex(
        (variant) => String(variant?.fileName || '') === track.fileName
    );

    if (existingIndex === -1) {
        variants.push({
            id: track.variantId,
            label: getVariantLabel(track.variantId),
            fileName: track.fileName,
            url: track.url,
            sizeBytes: track.sizeBytes
        });
        trackChanged = true;
    } else {
        const existing = variants[existingIndex];
        const next = {
            ...existing,
            url: track.url,
            sizeBytes: track.sizeBytes
        };
        if (
            existing.url !== next.url
            || Number(existing.sizeBytes) !== next.sizeBytes
        ) {
            variants[existingIndex] = next;
            trackChanged = true;
        }
    }

    if (trackChanged) {
        const nextSong = {
            ...song,
            variants,
            sizeBytes: variants.reduce(
                (total, variant) => total + (Number(variant?.sizeBytes) || 0),
                0
            )
        };
        songs[songIndex] = nextSong;
        changed = true;
    }
}

if (!changed) {
    console.log('audio-manifest.json allaqachon yangilangan.');
    process.exit(0);
}

const nextManifest = {
    ...manifest,
    songs,
    updatedAt: new Date().toISOString().slice(0, 10)
};

await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
console.log(
    `${discoveredTracks.length} ta MP3 tekshirildi; ` +
    `${removedVariantCount} ta variant va ${removedSongCount} ta qo‘shiq o‘chirildi; ` +
    `${manifestPath} yangilandi.`
);