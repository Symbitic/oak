// Copyright 2018-2020 the oak authors. All rights reserved. MIT license.

import { BufReader, ReadLineResult } from "./buf_reader.ts";
import { getFilename } from "./content_disposition.ts";
import { equals, extension } from "./deps.ts";
import { readHeaders, toParamRegExp, unquote } from "./headers.ts";
import { httpErrors } from "./httpError.ts";
import { getRandomFilename, skipLWSPChar, stripEol } from "./util.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const BOUNDARY_PARAM_REGEX = toParamRegExp("boundary", "i");
const DEFAULT_BUFFER_SIZE = 1048576; // 1mb
const DEFAULT_MAX_FILE_SIZE = 10485760; // 10mb
const DEFAULT_MAX_SIZE = 0; // all files written to disc
const NAME_PARAM_REGEX = toParamRegExp("name", "i");

export interface FormDataBody {
  /** A record of form parts where the key was the `name` of the part and the
   * value was the value of the part. This record does not include any files
   * that were part of the form data.
   * 
   * *Note*: Duplicate names are not included in this record, if there are
   * duplicates, the last value will be the value that is set here.  If there
   * is a possibility of duplicate values, use the `.stream()` method to
   * iterate over the values. */
  fields: Record<string, string>;

  /** An array of any files that were part of the form data. */
  files?: FormDataFile[];
}

/** A representation of a file that has been read from a form data body. */
export type FormDataFile = {
  /** When the file has not been written out to disc, the contents of the file
   * as a `Uint8Array`. */
  content?: Uint8Array;

  /** The content type og the form data file. */
  contentType: string;

  /** When the file has been written out to disc, the full path to the file. */
  filename?: string;

  /** The `name` that was assigned to the form data file. */
  name: string;

  /** The `filename` that was provided in the form data file. */
  originalName: string;
};

export interface FormDataReadOptions {
  /** The size of the buffer to read from the request body at a single time.
   * This defaults to 1mb. */
  bufferSize?: number;

  /** The maximum file size that can be handled.  This defaults to 10MB when
   * not specified.  This is to try to avoid DOS attacks where someone would 
   * continue to try to send a "file" continuously until a host limit was
   * reached crashing the server or the host. */
  maxFileSize?: number;

  /** The maximum size of a file to hold in memory, and not write to disk. This
   * defaults to `0`, so that all multipart form files are written to disk.
   * When set to a positive integer, if the form data file is smaller, it will
   * be retained in memory and available in the `.content` property of the
   * `FormDataFile` object.  If the file exceeds the `maxSize` it will be
   * written to disk and the `filename` file will contain the full path to the
   * output file. */
  maxSize?: number;

  /** When writing form data files to disk, the output path.  This will default
   * to a temporary path generated by `Deno.makeTempDir()`. */
  outPath?: string;

  /** When a form data file is written to disk, it will be generated with a
   * random filename and have an extension based off the content type for the
   * file.  `prefix` can be specified though to prepend to the file name. */
  prefix?: string;
}

interface PartsOptions {
  body: BufReader;
  final: Uint8Array;
  maxFileSize: number;
  maxSize: number;
  outPath?: string;
  part: Uint8Array;
  prefix?: string;
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const ab = new Uint8Array(a.length + b.length);
  ab.set(a, 0);
  ab.set(b, a.length);
  return ab;
}

function isEqual(a: Uint8Array, b: Uint8Array): boolean {
  return equals(skipLWSPChar(a), b);
}

async function readToStartOrEnd(
  body: BufReader,
  start: Uint8Array,
  end: Uint8Array,
): Promise<boolean> {
  let lineResult: ReadLineResult | null;
  while ((lineResult = await body.readLine())) {
    if (isEqual(lineResult.bytes, start)) {
      return true;
    }
    if (isEqual(lineResult.bytes, end)) {
      return false;
    }
  }
  throw new httpErrors.BadRequest(
    "Unable to find multi-part boundary.",
  );
}

/** Yield up individual parts by reading the body and parsing out the ford
 * data values. */
async function* parts(
  { body, final, part, maxFileSize, maxSize, outPath, prefix }: PartsOptions,
): AsyncIterableIterator<[string, string | FormDataFile]> {
  async function getFile(contentType: string): Promise<[string, Deno.File]> {
    const ext = extension(contentType);
    if (!ext) {
      throw new httpErrors.BadRequest(`Invalid media type for part: ${ext}`);
    }
    if (!outPath) {
      outPath = await Deno.makeTempDir();
    }
    const filename = `${outPath}/${getRandomFilename(prefix, ext)}`;
    const file = await Deno.open(filename, { write: true, createNew: true });
    return [filename, file];
  }

  while (true) {
    const headers = await readHeaders(body);
    const contentType = headers["content-type"];
    const contentDisposition = headers["content-disposition"];
    if (!contentDisposition) {
      throw new httpErrors.BadRequest(
        "Form data part missing content-disposition header",
      );
    }
    if (!contentDisposition.match(/^form-data;/i)) {
      throw new httpErrors.BadRequest(
        `Unexpected content-disposition header: "${contentDisposition}"`,
      );
    }
    const matches = NAME_PARAM_REGEX.exec(contentDisposition);
    if (!matches) {
      throw new httpErrors.BadRequest(
        `Unable to determine name of form body part`,
      );
    }
    let [, name] = matches;
    name = unquote(name);
    if (contentType) {
      const originalName = getFilename(contentDisposition);
      let byteLength = 0;
      let file: Deno.File | undefined;
      let filename: string | undefined;
      let buf: Uint8Array | undefined;
      if (maxSize) {
        buf = new Uint8Array();
      } else {
        const result = await getFile(contentType);
        filename = result[0];
        file = result[1];
      }
      while (true) {
        const readResult = await body.readLine(false);
        if (!readResult) {
          throw new httpErrors.BadRequest("Unexpected EOF reached");
        }
        const { bytes } = readResult;
        const strippedBytes = stripEol(bytes);
        if (isEqual(strippedBytes, part) || isEqual(strippedBytes, final)) {
          if (file) {
            file.close();
          }
          yield [
            name,
            {
              content: buf,
              contentType,
              name,
              filename,
              originalName,
            } as FormDataFile,
          ];
          if (isEqual(strippedBytes, final)) {
            return;
          }
          break;
        }
        byteLength += bytes.byteLength;
        if (byteLength > maxFileSize) {
          if (file) {
            file.close();
          }
          throw new httpErrors.RequestEntityTooLarge(
            `File size exceeds limit of ${maxFileSize} bytes.`,
          );
        }
        if (buf) {
          if (byteLength > maxSize) {
            const result = await getFile(contentType);
            filename = result[0];
            file = result[1];
            await Deno.writeAll(file, buf);
            buf = undefined;
          } else {
            buf = append(buf, bytes);
          }
        }
        if (file) {
          await Deno.writeAll(file, bytes);
        }
      }
    } else {
      const lines: string[] = [];
      while (true) {
        const readResult = await body.readLine();
        if (!readResult) {
          throw new httpErrors.BadRequest("Unexpected EOF reached");
        }
        const { bytes } = readResult;
        if (isEqual(bytes, part) || isEqual(bytes, final)) {
          yield [name, lines.join("\n")];
          if (isEqual(bytes, final)) {
            return;
          }
          break;
        }
        lines.push(decoder.decode(bytes));
      }
    }
  }
}

/** A class which provides an interface to access the fields of a
 * `multipart/form-data` body. */
export class FormDataReader {
  #body: Deno.Reader;
  #boundaryFinal: Uint8Array;
  #boundaryPart: Uint8Array;
  #reading = false;

  constructor(contentType: string, body: Deno.Reader) {
    const matches = contentType.match(BOUNDARY_PARAM_REGEX);
    if (!matches) {
      throw new httpErrors.BadRequest(
        `Content type "${contentType}" does not contain a valid boundary.`,
      );
    }
    let [, boundary] = matches;
    boundary = unquote(boundary);
    this.#boundaryPart = encoder.encode(`--${boundary}`);
    this.#boundaryFinal = encoder.encode(`--${boundary}--`);
    this.#body = body;
  }

  /** Reads the multipart body of the response and resolves with an object which
   * contains fields and files that were part of the response.
   * 
   * *Note*: this method handles multiple files with the same `name` attribute
   * in the request, but by design it does not handle multiple fields that share
   * the same `name`.  If you expect the request body to contain multiple form
   * data fields with the same name, it is better to use the `.stream()` method
   * which will iterate over each form data field individually. */
  async read(options: FormDataReadOptions = {}): Promise<FormDataBody> {
    if (this.#reading) {
      throw new Error("Body is already being read.");
    }
    this.#reading = true;
    const {
      outPath,
      maxFileSize = DEFAULT_MAX_FILE_SIZE,
      maxSize = DEFAULT_MAX_SIZE,
      bufferSize = DEFAULT_BUFFER_SIZE,
    } = options;
    const body = new BufReader(this.#body, bufferSize);
    const result: FormDataBody = { fields: {} };
    if (
      !(await readToStartOrEnd(body, this.#boundaryPart, this.#boundaryFinal))
    ) {
      return result;
    }
    try {
      for await (
        const part of parts({
          body,
          part: this.#boundaryPart,
          final: this.#boundaryFinal,
          maxFileSize,
          maxSize,
          outPath,
        })
      ) {
        const [key, value] = part;
        if (typeof value === "string") {
          result.fields[key] = value;
        } else {
          if (!result.files) {
            result.files = [];
          }
          result.files.push(value);
        }
      }
    } catch (err) {
      if (err instanceof Deno.errors.PermissionDenied) {
        console.error(err.stack ? err.stack : `${err.name}: ${err.message}`);
      } else {
        throw err;
      }
    }
    return result;
  }

  /** Returns an iterator which will asynchronously yield each part of the form
   * data.  The yielded value is a tuple, where the first element is the name
   * of the part and the second element is a `string` or a `FormDataFile`
   * object. */
  async *stream(
    options: FormDataReadOptions = {},
  ): AsyncIterableIterator<[string, string | FormDataFile]> {
    if (this.#reading) {
      throw new Error("Body is already being read.");
    }
    this.#reading = true;
    const {
      outPath,
      maxFileSize = DEFAULT_MAX_FILE_SIZE,
      maxSize = DEFAULT_MAX_SIZE,
      bufferSize = 32000,
    } = options;
    const body = new BufReader(this.#body, bufferSize);
    if (
      !(await readToStartOrEnd(body, this.#boundaryPart, this.#boundaryFinal))
    ) {
      return;
    }
    try {
      for await (
        const part of parts({
          body,
          part: this.#boundaryPart,
          final: this.#boundaryFinal,
          maxFileSize,
          maxSize,
          outPath,
        })
      ) {
        yield part;
      }
    } catch (err) {
      if (err instanceof Deno.errors.PermissionDenied) {
        console.error(err.stack ? err.stack : `${err.name}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
}
