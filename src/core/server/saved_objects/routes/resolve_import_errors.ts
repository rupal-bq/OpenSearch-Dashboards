/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { extname } from 'path';
import { Readable } from 'stream';
import { schema } from '@osd/config-schema';
import { IRouter } from '../../http';
import { resolveSavedObjectsImportErrors } from '../import';
import { SavedObjectConfig } from '../saved_objects_config';
import { createSavedObjectsStreamFromNdJson } from './utils';

interface FileStream extends Readable {
  hapi: {
    filename: string;
  };
}

export const registerResolveImportErrorsRoute = (router: IRouter, config: SavedObjectConfig) => {
  const { maxImportExportSize, maxImportPayloadBytes } = config;

  router.post(
    {
      path: '/_resolve_import_errors',
      options: {
        body: {
          maxBytes: maxImportPayloadBytes,
          output: 'stream',
          accepts: 'multipart/form-data',
        },
      },
      validate: {
        query: schema.object({
          createNewCopies: schema.boolean({ defaultValue: false }),
          dataSourceId: schema.maybe(schema.string({ defaultValue: '' })),
        }),
        body: schema.object({
          file: schema.stream(),
          retries: schema.arrayOf(
            schema.object({
              type: schema.string(),
              id: schema.string(),
              overwrite: schema.boolean({ defaultValue: false }),
              destinationId: schema.maybe(schema.string()),
              replaceReferences: schema.arrayOf(
                schema.object({
                  type: schema.string(),
                  from: schema.string(),
                  to: schema.string(),
                }),
                { defaultValue: [] }
              ),
              createNewCopy: schema.maybe(schema.boolean()),
              ignoreMissingReferences: schema.maybe(schema.boolean()),
            })
          ),
        }),
      },
    },
    router.handleLegacyErrors(async (context, req, res) => {
      const file = req.body.file as FileStream;
      const fileExtension = extname(file.hapi.filename).toLowerCase();
      if (fileExtension !== '.ndjson') {
        return res.badRequest({ body: `Invalid file extension ${fileExtension}` });
      }

      const dataSourceId = req.query.dataSourceId;

      // get datasource from saved object service

      const dataSource = dataSourceId
        ? await context.core.savedObjects.client
            .get('data-source', dataSourceId)
            .then((response) => {
              const attributes: any = response?.attributes || {};
              return {
                id: response.id,
                title: attributes.title,
              };
            })
        : '';

      const dataSourceTitle = dataSource ? dataSource.title : '';

      let readStream: Readable;
      try {
        readStream = await createSavedObjectsStreamFromNdJson(file);
      } catch (e) {
        return res.badRequest({
          body: e,
        });
      }

      const result = await resolveSavedObjectsImportErrors({
        typeRegistry: context.core.savedObjects.typeRegistry,
        savedObjectsClient: context.core.savedObjects.client,
        readStream,
        retries: req.body.retries,
        objectLimit: maxImportExportSize,
        createNewCopies: req.query.createNewCopies,
        dataSourceId,
        dataSourceTitle,
      });

      return res.ok({ body: result });
    })
  );
};
