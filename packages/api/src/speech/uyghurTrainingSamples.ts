import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_TRANSCRIPT_LENGTH = 20_000;
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};

export interface SaveUyghurTrainingSampleInput {
  modelDirectory: string;
  userId: string;
  audio: Uint8Array;
  mimeType: string;
  transcript: string;
}

/** Saves an explicitly corrected local ASR sample with owner-only file permissions. */
export async function saveUyghurTrainingSample({
  modelDirectory,
  userId,
  audio,
  mimeType,
  transcript,
}: SaveUyghurTrainingSampleInput): Promise<{ sampleId: string }> {
  const normalizedMimeType = mimeType.split(';', 1)[0].trim().toLowerCase();
  const extension = AUDIO_EXTENSIONS[normalizedMimeType];
  const correctedText = transcript.trim();

  if (!modelDirectory || !userId || audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Invalid local Uyghur training sample input.');
  }
  if (!extension || correctedText.length === 0 || correctedText.length > MAX_TRANSCRIPT_LENGTH) {
    throw new Error('Invalid local Uyghur training sample input.');
  }

  const dataDirectory = path.join(path.dirname(path.resolve(modelDirectory)), 'training-data');
  const ownerDirectory = path.join(
    dataDirectory,
    createHash('sha256').update(userId).digest('hex'),
  );
  const sampleId = randomUUID();
  const stagingDirectory = path.join(ownerDirectory, `.pending-${sampleId}`);
  const sampleDirectory = path.join(ownerDirectory, sampleId);

  await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  await chmod(ownerDirectory, 0o700);
  await mkdir(stagingDirectory, { mode: 0o700 });

  try {
    await writeFile(path.join(stagingDirectory, `audio.${extension}`), audio, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      path.join(stagingDirectory, 'metadata.json'),
      JSON.stringify(
        {
          sampleId,
          createdAt: new Date().toISOString(),
          language: 'ug',
          script: 'Uyghur Arabic',
          mimeType: normalizedMimeType,
          transcript: correctedText,
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    await rename(stagingDirectory, sampleDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { sampleId };
}
