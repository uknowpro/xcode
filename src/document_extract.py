"""Read small, explicitly selected Office or CSV sections without executing content."""
import csv
import json
import posixpath
import re
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


def heading_level(element):
    style = element.find(WORD + "pPr/" + WORD + "pStyle")
    match = re.fullmatch(r"Heading(?:\s*)([1-9])", style.get(WORD + "val", ""), re.I) if style is not None else None
    return int(match[1]) if match else None


def word_rows(archive, part, heading, table, outline):
    root = xml(archive, "word/document.xml")
    body = root.find(WORD + "body")
    if body is None:
        return
    active = not heading
    level = 0
    index = 0
    for element in body:
        if element.tag == WORD + "p":
            value = cell_text(element, WORD)
            depth = heading_level(element)
            if outline:
                if depth and value:
                    yield {"heading": value, "level": depth}
                continue
            if heading and depth:
                if active and depth <= level:
                    break
                if not active and value == heading:
                    active, level = True, depth
            if active and not table and part != "tables" and value:
                yield value
        elif element.tag == WORD + "tbl":
            index += 1
            if active and not outline and part != "paragraphs" and (not table or index == int(table)):
                for row in element.findall(WORD + "tr"):
                    yield [cell_text(cell, WORD) for cell in row.findall(WORD + "tc")[:60]]


def coordinates(reference):
    match = re.fullmatch(r"\$?([A-Z]{1,3})\$?([1-9][0-9]*)", reference, re.I)
    if not match:
        raise ValueError("Invalid cell reference")
    column = 0
    for code in match[1].upper():
        column = column * 26 + ord(code) - 64
    return int(match[2]), column


def archive_path(base, target):
    path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(base, target))
    if not path.startswith("xl/") or "://" in target:
        raise ValueError("Worksheet is not stored inside this file")
    return path


def sheet_location(archive, book, name, selected):
    relations = {item.attrib["Id"]: item.attrib["Target"] for item in xml(archive, "xl/_rels/workbook.xml.rels")}
    sheets = [(item.get("name"), archive_path("xl", relations.get(item.get(REL + "id"), "")))
              for item in book.iter(SHEET + "sheet")]
    choices = [item for item in sheets if name is None or item[0] == name]
    if selected:
        defined = next((item for item in book.iter(SHEET + "definedName") if item.get("name") == selected), None)
        if defined is not None:
            formula = (defined.text or "").lstrip("=")
            match = re.fullmatch(r"('(?:[^']|'')+'|[^!]+)!([A-Z0-9$:]+)", formula, re.I)
            if not match:
                raise ValueError("Unsupported named range")
            sheet_name = match[1].strip("'").replace("''", "'")
            return next(path for name, path in choices if name == sheet_name), match[2], None
        for _name, path in choices:
            folder, basename = posixpath.split(path)
            rel = folder + "/_rels/" + basename + ".rels"
            if rel not in archive.namelist():
                continue
            for element in xml(archive, rel):
                if not element.get("Type", "").endswith("/table"):
                    continue
                target = xml(archive, archive_path(folder, element.get("Target", "")))
                if selected in {target.get("name"), target.get("displayName")}:
                    columns = [item.get("name") for item in target.iter(SHEET + "tableColumn")]
                    return path, target.get("ref"), columns
        raise ValueError("Named table or range not found")
    if not choices:
        raise ValueError("Worksheet was not found")
    return choices[0][1], None, None


def sheet_rows(archive, name, selected, output):
    book = xml(archive, "xl/workbook.xml")
    path, selected_range, headers = sheet_location(archive, book, name, selected)
    if headers:
        output["headers"] = headers[:60]
    low, high = None, None
    if selected_range:
        references = selected_range.split(":")
        low, high = coordinates(references[0]), coordinates(references[-1])
        output["range"] = selected_range
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
            ref = cell.get("r")
            if low:
                rownum, column = coordinates(ref or "")
                if not low[0] <= rownum <= high[0] or not low[1] <= column <= high[1]:
                    continue
            formula = cell.findtext(SHEET + "f")
            item = {"cell": ref, "value": value[:2000]}
            if formula is not None:
                item["formula"] = formula[:2000]
            cells.append(item)
        if cells or low is None:
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
    path, part, sheet, offset, count, heading, table, selected, outline = sys.argv[1:]
    offset, count = int(offset), int(count)
    kind = Path(path).suffix.lower()
    if kind in {".csv", ".tsv"}:
        with open(path, "r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, delimiter="\t" if kind == ".tsv" else ",")
            result = sliced(([value[:2000] for value in row[:60]] for row in reader), offset, count)
    else:
        with zipfile.ZipFile(path) as archive:
            extra = {}
            rows = word_rows(archive, part, heading, table, outline == "1") if kind == ".docx" else sheet_rows(archive, sheet or None, selected, extra)
            result = {**sliced(rows, offset, count), **extra}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, ET.ParseError, KeyError, IndexError, RuntimeError, StopIteration, zipfile.BadZipFile):
        sys.exit("File is protected, unsupported, damaged or exceeds extraction limits.")
