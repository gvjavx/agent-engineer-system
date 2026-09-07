// pdfmake 0.3.x exports a configured singleton, not the 0.2.x-era printer
// class that @types/pdfmake describes. Only the surface markdownPdf.ts touches.
declare module "pdfmake" {
  interface PdfDoc {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMake {
    virtualfs: { writeFileSync(name: string, content: Buffer): void };
    setFonts(fonts: Record<string, Record<string, string>>): void;
    setUrlAccessPolicy(cb: (url: string) => boolean): void;
    setLocalAccessPolicy(cb: (path: string) => boolean): void;
    createPdf(docDefinition: unknown): PdfDoc;
  }
  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts.js" {
  const vfs: Record<string, string>;
  export default vfs;
}
