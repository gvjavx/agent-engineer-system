// html-to-docx ships no types. Only the one call shape documentGen.ts uses.
declare module "html-to-docx" {
  interface DocxOptions {
    footer?: boolean;
    header?: boolean;
    pageNumber?: boolean;
    [key: string]: unknown;
  }
  export default function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string,
    documentOptions?: DocxOptions,
    footerHTMLString?: string
  ): Promise<Buffer | ArrayBuffer | Blob>;
}
