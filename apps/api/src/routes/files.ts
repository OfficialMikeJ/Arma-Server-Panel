import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { FILE_MANAGER, cuidSchema, filePathSchema, writeFileSchema } from '@asp/shared';

import { assertPermission, resolveServerAccess } from '../plugins/auth.js';
import { audit, AuditAction } from '../security/audit.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { loadServer } from '../modules/servers/server-service.js';
import {
  createDirectory,
  deletePath,
  isEditable,
  listDirectory,
  movePath,
  openDownloadStream,
  readTextFile,
  resolveWithin,
  writeTextFile,
} from '../modules/files/file-service.js';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  const guard = { onRequest: [app.requireAuth, app.requireActiveAccount] };

  app.get('/servers/:id/files', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.read');

    const query = z.object({ path: filePathSchema.default('') }).parse(request.query ?? {});
    const server = await loadServer(id);

    return reply.send({
      path: query.path,
      entries: await listDirectory(server.volumePath, query.path),
      editableExtensions: FILE_MANAGER.editableExtensions,
    });
  });

  app.get('/servers/:id/files/content', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.read');

    const query = z.object({ path: filePathSchema }).parse(request.query ?? {});
    const server = await loadServer(id);

    return reply.send({
      path: query.path,
      content: await readTextFile(server.volumePath, query.path),
      editable: isEditable(path.basename(query.path)),
    });
  });

  app.put('/servers/:id/files/content', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.write');

    const body = writeFileSchema.parse(request.body);
    const server = await loadServer(id);

    await writeTextFile(server.volumePath, body.path, body.content);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.FileWritten,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { path: body.path, bytes: Buffer.byteLength(body.content) },
    });

    return reply.send({ ok: true });
  });

  app.post('/servers/:id/files/directory', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.write');

    const body = z.object({ path: filePathSchema }).parse(request.body);
    const server = await loadServer(id);

    await createDirectory(server.volumePath, body.path);
    return reply.status(201).send({ ok: true });
  });

  app.post('/servers/:id/files/move', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.write');

    const body = z.object({ from: filePathSchema, to: filePathSchema }).parse(request.body);
    const server = await loadServer(id);

    await movePath(server.volumePath, body.from, body.to);
    return reply.send({ ok: true });
  });

  app.delete('/servers/:id/files', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.write');

    const body = z.object({ path: filePathSchema }).parse(request.body);
    const server = await loadServer(id);

    await deletePath(server.volumePath, body.path);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.FileDeleted,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { path: body.path },
    });

    return reply.send({ ok: true });
  });

  /* ---- Download ---- */

  app.get('/servers/:id/files/download', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.read');

    const query = z.object({ path: filePathSchema }).parse(request.query ?? {});
    const server = await loadServer(id);
    const download = await openDownloadStream(server.volumePath, query.path);

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.FileDownloaded,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { path: query.path, bytes: download.size },
    });

    // application/octet-stream + attachment + nosniff: the browser must never
    // render a downloaded server file inline, or an uploaded .html becomes XSS.
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(download.size))
      .header(
        'content-disposition',
        `attachment; filename="${download.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(download.stream);
  });

  /* ---- Upload ---- */

  app.post('/servers/:id/files/upload', guard, async (request, reply) => {
    const { id } = z.object({ id: cuidSchema }).parse(request.params);
    const access = await resolveServerAccess(request, id);
    assertPermission(access, 'server:files.write');

    const server = await loadServer(id);
    const data = await request.file();
    if (!data) throw badRequest('No file was uploaded.');

    // The destination folder arrives as a multipart field, so validate it with
    // the same schema the JSON routes use.
    const rawDestination = (data.fields.path as { value?: unknown } | undefined)?.value;
    const destination = filePathSchema.parse(
      typeof rawDestination === 'string' ? rawDestination : '',
    );

    const filename = path.basename(data.filename ?? 'upload.bin').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!filename || filename.startsWith('.')) {
      throw badRequest('That filename is not allowed.');
    }

    const targetRelative = path.posix.join(destination, filename).replace(/^\/+/, '');
    const absolute = await resolveWithin(server.volumePath, targetRelative);

    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o750 });

    try {
      await pipeline(data.file, createWriteStream(absolute, { mode: 0o640 }));
    } catch (error) {
      await rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }

    // `file.truncated` is set when the size limit was hit mid-stream; a partial
    // file on disk would be worse than none.
    if (data.file.truncated) {
      await rm(absolute, { force: true }).catch(() => undefined);
      throw forbidden(
        `That file is larger than the ${Math.round(FILE_MANAGER.maxUploadBytes / 1024 / 1024)} MB upload limit.`,
      );
    }

    await audit({
      accountId: request.auth.account!.id,
      actorLabel: request.auth.account!.username,
      action: AuditAction.FileWritten,
      targetType: 'server',
      targetId: id,
      ipHash: request.auth.client.ipHash,
      userAgentHash: request.auth.client.userAgentHash,
      metadata: { path: targetRelative, upload: true },
    });

    return reply.status(201).send({ ok: true, path: targetRelative });
  });
}
