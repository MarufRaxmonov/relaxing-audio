#!/usr/bin/env node

import { readdir, rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const audioDirectory = process.env.AUDIO_DIRECTORY || 'audio';
const lyricDirectories = ['lyrics'];

async function collectFiles(directory, relativeDirectory = '') {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const files = [];
    for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
        if (entry.isDirectory()) {
            files.push(...await collectFiles(fullPath, relativePath));
        } else if (entry.isFile()) {
            files.push({ fullPath, relativePath });
        }
    }
    return files;
}

function getNumberedSongPart(fileName) {
    const extension = extname(fileName);
    const baseName = fileName.slice(0, -extension.length);
    const match = baseName.match(/^(.*?)(\d+)(.*)$/);
    if (!match) return null;
    return {
        prefix: match[1],
        number: Number(match[2]),
        suffix: match[3],
        extension
    };
}

const audioFiles = (await collectFiles(audioDirectory))
    .filter((file) => /\.mp3$/i.test(file.relativePath));
const groups = new Map();

for (const file of audioFiles) {
    const fileName = basename(file.relativePath);
    const separatorIndex = fileName.lastIndexOf('__');
    if (separatorIndex <= 0) continue;

    const songPart = getNumberedSongPart(fileName.slice(0, separatorIndex) + '.mp3');
    if (!songPart) continue;

    const groupKey = songPart.prefix;
    if (!groups.has(groupKey)) groups.set(groupKey, new Map());
    const numberGroup = groups.get(groupKey);
    if (!numberGroup.has(songPart.number)) numberGroup.set(songPart.number, []);
    numberGroup.get(songPart.number).push({
        ...file,
        fileName,
        variantSuffix: fileName.slice(separatorIndex)
    });
}

const moves = [];
for (const [prefix, numberGroup] of groups) {
    const oldNumbers = [...numberGroup.keys()].sort((left, right) => left - right);
    oldNumbers.forEach((oldNumber, index) => {
        const nextNumber = index + 1;
        for (const file of numberGroup.get(oldNumber)) {
            const nextFileName = `${prefix}${nextNumber}${file.variantSuffix}`;
            const nextPath = join(dirname(file.fullPath), nextFileName);
            if (nextPath !== file.fullPath) {
                moves.push({ from: file.fullPath, to: nextPath });
            }
        }
    });
}

for (const directory of lyricDirectories) {
    const lyricFiles = await collectFiles(directory);
    for (const file of lyricFiles) {
        const parsed = getNumberedSongPart(basename(file.relativePath));
        if (!parsed) continue;
        const numberGroup = groups.get(parsed.prefix);
        if (!numberGroup) continue;
        const oldNumbers = [...numberGroup.keys()].sort((left, right) => left - right);
        const oldIndex = oldNumbers.indexOf(parsed.number);
        if (oldIndex === -1) continue;
        const nextFileName =
            `${parsed.prefix}${oldIndex + 1}${parsed.suffix}${parsed.extension}`;
        const nextPath = join(dirname(file.fullPath), nextFileName);
        if (nextPath !== file.fullPath) {
            moves.push({ from: file.fullPath, to: nextPath });
        }
    }
}

const sourcePaths = new Set(moves.map((move) => move.from));
for (const move of moves) {
    if (sourcePaths.has(move.to)) continue;
    try {
        await readdir(move.to);
        throw new Error(`Renumberlash to‘qnashuvi: ${move.to}`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

if (!moves.length) {
    console.log('Audio tartibi allaqachon ketma-ket.');
    process.exit(0);
}

const temporaryMoves = moves.map((move, index) => ({
    ...move,
    temporary: `${move.from}.renaming-${process.pid}-${index}`
}));

for (const move of temporaryMoves) {
    await rename(move.from, move.temporary);
}
for (const move of temporaryMoves) {
    await rename(move.temporary, move.to);
}

console.log(`${moves.length} ta audio/lyrics fayli ketma-ket raqamlandi.`);