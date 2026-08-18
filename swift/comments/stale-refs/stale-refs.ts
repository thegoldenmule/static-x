import path from 'node:path';
import { toBlocks } from '../../../core/comments/index.js';
import type { Finding, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { positionAt } from '../../../core/text/index.js';
import { SwiftProjectSession } from '../../project/index.js';
import { commentFileFor } from '../ranges.js';
import { semanticTokensFor } from '../tokens.js';
import { SWIFT_DIRECTIVE, swiftContentOf } from '../conventions.js';
import { buildCorpus } from './corpus.js';
import { extractCandidates } from './extract.js';
import { SWIFT_PROSE_STOPLIST } from './keywords.js';
import { parametersFor } from './parameters.js';

interface StaleRefsInput {
  /**
   * Extra directories whose declarations count as resolving — a sibling
   * package a comment legitimately names. Scanned for names only.
   */
  extraRoots?: string[];
}

export const swiftStaleRefs: Tool<StaleRefsInput, Finding[], SwiftProjectSession> = {
  name: 'swift/comments/stale-refs',
  description:
    'Finds references in comments that no longer resolve: a DocC symbol link or backtick span ' +
    'naming a symbol nothing declares, a file reference to a file that is gone, or a ' +
    '- Parameter tag naming no parameter of the function it documents. Resolution spans the ' +
    'whole project plus the Swift and Apple SDK name index; findings carry a confidence.',
  inputSchema: {
    type: 'object',
    properties: {
      extraRoots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra directories whose declared names count as resolving',
      },
    },
    additionalProperties: false,
  },
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  async run(session, input) {
    const corpus = await buildCorpus(session);
    const extra = new Set<string>();
    for (const root of input.extraRoots ?? []) {
      const resolved = path.resolve(session.rootPath, root);
      // Opening a second session is the honest way to read another
      // project's names: they come from the same compiler
      // classification as this project's. A root that does not bind
      // throws rather than quietly contributing nothing — an extraRoot
      // silently ignored would look exactly like one whose names did
      // not help.
      const other = SwiftProjectSession.open(resolved);
      try {
        for (const name of (await buildCorpus(other)).names) extra.add(name);
      } finally {
        await other.dispose();
      }
    }

    const findings: Finding[] = [];
    for (const file of session.targetFiles()) {
      const commentFile = await commentFileFor(session, file);
      const { lineStarts, text } = await semanticTokensFor(session, file);

      for (const block of toBlocks(commentFile, SWIFT_DIRECTIVE)) {
        const raw = text.slice(block.pos, block.end);
        const content = swiftContentOf(raw);
        // Offsets are into the stripped prose, so map back through the
        // raw comment to point at the reference itself rather than the
        // block — a finding you cannot navigate to is a finding nobody
        // acts on.
        const parameters = block.doc ? parametersFor(text, lineStarts, block) : undefined;

        for (const candidate of extractCandidates(content)) {
          const where = raw.indexOf(candidate.raw);
          const pos = block.pos + (where >= 0 ? where : 0);
          const range = {
            start: positionAt(lineStarts, pos),
            end: positionAt(lineStarts, pos + candidate.raw.length),
          };

          if (candidate.source === 'param-tag') {
            if (parameters && !parameters.accepted.has(candidate.raw)) {
              findings.push({
                file,
                range,
                code: 'comment.stale-param',
                message:
                  `- Parameter "${candidate.raw}" does not match any parameter of the ` +
                  `documented declaration (parameters: ${parameters.display.join(', ')}).`,
                severity: 'warning',
                data: { name: candidate.raw, source: candidate.source, confidence: 'high' },
              });
            }
            continue;
          }

          if (candidate.isFile) {
            if (!corpus.files.has(path.basename(candidate.raw))) {
              findings.push({
                file,
                range,
                code: 'comment.stale-ref',
                message: `Comment references the file "${candidate.raw}", which is not in this project.`,
                severity: 'warning',
                data: {
                  name: candidate.raw,
                  source: candidate.source,
                  confidence: 'medium',
                  kind: 'file',
                },
              });
            }
            continue;
          }

          if (SWIFT_PROSE_STOPLIST.has(candidate.raw)) continue;
          // A chain resolves if any segment does: a comment naming
          // `URL.absoluteString` is naming something real even when the
          // member is not indexed on its own.
          const resolves = candidate.segments.some(
            (segment) => corpus.has(segment) || extra.has(segment),
          );
          if (resolves) continue;

          const bare = candidate.source === 'bare';
          findings.push({
            file,
            range,
            code: 'comment.stale-ref',
            message: `Comment references "${candidate.raw}", which does not resolve to any symbol in this project or the SDK.`,
            severity: bare ? 'info' : 'warning',
            data: {
              name: candidate.raw,
              source: candidate.source,
              confidence: bare ? 'low' : 'medium',
            },
          });
        }
      }
    }
    return findings;
  },
};
