"""Read small, explicitly selected Office or CSV sections without executing content."""
import csv
import json
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def xml(archive, name):
    info = archive.getinfo(name)
    if info.file_size > 8 * 1024 * 1024 or info.flag_bits & 1:
        raise ValueError("Document item is encrypted or too large")
    data = archive.read(info)
    if b"<!DOCTYPE" in data.upper():
        raise ValueError("Document declarations are disabled")
    return ET.fromstring(data)


def cell_text(element, prefix):
    return "".join(node.text or "" for node in element.iter(prefix + "t"))[:2000]


def word_rows(archive, part):
    root = xml(archive, "word/document.xml")
    body = root.find(WORD + "body")
    if body is None:
        return
    for element in body:
        if element.tag == WORD + "p" and part != "tables":
            value = cell_text(element, WORD)
            if value:
                yield value
        elif element.tag == WORD + "tbl" and part != "paragraphs":
            for row in element.findall(WORD + "tr"):
                yield [cell_text(cell, WORD) for cell in row.findall(WORD + "tc")[:60]]


def sheet_rows(archive, name):
    book = xml(archive, "xl/workbook.xml")
    relations = {item.attrib["Id"]: item.attrib["Target"] for item in xml(archive, "xl/_rels/workbook.xml.rels")}
    sheet = next((item for item in book.iter(SHEET + "sheet") if name is None or item.get("name") == name), None)
    if sheet is None:
        raise ValueError("Worksheet was not found")
    target = relations.get(sheet.get(REL + "id"), "")
    path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
    if not path.startswith("xl/") or "://" in target:
        raise ValueError("Worksheet is not stored inside this file")
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = [cell_text(item, SHEET) for item in xml(archive, "xl/sharedStrings.xml").iter(SHEET + "si")]
    for row in xml(archive, path).iter(SHEET + "row"):
        cells = []
        for cell in row.findall(SHEET + "c")[:60]:
            value = cell.findtext(SHEET + "v", default="")
            if cell.get("t") == "s":
                value = shared[int(value)]
            elif cell.get("t") == "inlineStr":
                value = cell_text(cell, SHEET)
            cells.append({"cell": cell.get("r"), "value": value[:2000]})
        yield cells


def sliced(rows, offset, count):
    result = []
    for index, row in enumerate(rows):
        if index >= offset + count:
            return {"rows": result, "nextOffset": offset + count}
        if index >= offset:
            result.append(row)
    return {"rows": result}


def main():
    path, part, sheet, offset, count = sys.argv[1:]
    offset, count = int(offset), int(count)
    kind = Path(path).suffix.lower()
    if kind in {".csv", ".tsv"}:
        with open(path, "r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, delimiter="\t" if kind == ".tsv" else ",")
            result = sliced(([value[:2000] for value in row[:60]] for row in reader), offset, count)
    else:
        with zipfile.ZipFile(path) as archive:
            rows = word_rows(archive, part) if kind == ".docx" else sheet_rows(archive, sheet or None)
            result = sliced(rows, offset, count)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, ET.ParseError, KeyError, IndexError, RuntimeError, zipfile.BadZipFile):
        sys.exit("File is protected, unsupported, damaged or exceeds extraction limits.")
