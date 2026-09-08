const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

function safeSegment(value, fallback) {
  const cleaned = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100);
  return cleaned || fallback;
}
function storedFile(uploadRoot, relativePath) { if (!relativePath) return null; const root = path.resolve(uploadRoot); const resolved = path.resolve(root, String(relativePath)); return resolved !== root && resolved.startsWith(`${root}${path.sep}`) ? resolved : null; }
function imageExtension(filePath) { const extension = path.extname(String(filePath || '')).toLowerCase(); return ['.png', '.jpg', '.jpeg', '.webp'].includes(extension) ? extension : '.png'; }
const mimeType = (filePath) => imageExtension(filePath) === '.webp' ? 'image/webp' : ['.jpg', '.jpeg'].includes(imageExtension(filePath)) ? 'image/jpeg' : 'image/png';
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function addFile({ zip, uploadRoot, relativePath, filename, metadata, files, missingFiles, includeFileSize = true }) {
  const resolved = storedFile(uploadRoot, relativePath);
  if (!resolved) { missingFiles.push({ ...metadata, filePath: relativePath, reason: relativePath ? 'invalid_path' : 'path_not_recorded' }); return; }
  try {
    const buffer = await fs.promises.readFile(resolved);
    zip.file(filename, buffer);
    files.push({ ...metadata, filename, ...(includeFileSize ? { fileSize: buffer.length } : {}), sha256: sha256(buffer) });
  } catch (error) { missingFiles.push({ ...metadata, filePath: relativePath, reason: error.code === 'ENOENT' ? 'file_not_found' : 'read_failed', ...(error.code === 'ENOENT' ? {} : { error: String(error.message || error).slice(0, 300) }) }); }
}

async function buildTaskImageArchive({ uploadRoot, task, participants, snapshots }) {
  const zip = new JSZip(); const files = []; const missingFiles = [];
  const backgroundExtension = imageExtension(task.background_path);
  await addFile({ zip, uploadRoot, relativePath: task.background_path, filename: `templates/practice${backgroundExtension}`,
    metadata: { type: 'template', phase: 'practice', originalName: task.background_original_name || path.basename(String(task.background_path || 'background')) }, files, missingFiles, includeFileSize: false });
  for (const snapshot of snapshots) {
    const studentCode = safeSegment(snapshot.student_number || snapshot.display_name, 'unknown');
    const attemptNumber = Math.max(1, Number(snapshot.attempt_number) || 1);
    const attemptDirectory = `attempt-${String(attemptNumber).padStart(3, '0')}`;
    const extension = imageExtension(snapshot.image_path);
    const kind = snapshot.snapshot_kind || 'legacy';
    const sampleIndex = Number(snapshot.sample_index ?? snapshot.sequence) || 0;
    const basename = kind === 'final' ? `final${extension}` : `${String(sampleIndex).padStart(6, '0')}_${safeSegment(kind, 'legacy')}${extension}`;
    const filename = path.posix.join(studentCode, 'practice', attemptDirectory, kind === 'final' ? 'final' : 'snapshots', basename);
    await addFile({ zip, uploadRoot, relativePath: snapshot.image_path, filename, metadata: {
      type: 'snapshot', snapshotId: snapshot.id, sessionId: snapshot.workspace_id, studentCode, phase: 'practice',
      attemptNumber, snapshotKind: kind, sampleIndex, activeSeconds: snapshot.active_seconds,
      operationSeq: snapshot.operation_count, visualVersion: snapshot.operation_count, snapshotReason: kind, mimeType: mimeType(snapshot.image_path)
    }, files, missingFiles });
  }
  if (missingFiles.length) zip.file('missing-files.json', JSON.stringify(missingFiles, null, 2));
  zip.file('manifest.json', JSON.stringify({ experimentId: task.id, title: task.title, generatedAt: new Date().toISOString(),
    fileCount: files.length, snapshotFileCount: files.filter((item) => item.type === 'snapshot').length,
    templateFileCount: files.filter((item) => item.type === 'template').length,
    missingFileCount: missingFiles.length, files, missingFiles }, null, 2));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildTaskImageArchive, safeSegment };
