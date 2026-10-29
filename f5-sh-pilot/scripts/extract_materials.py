"""只读提取原始附件；不修正文案、标准答案或被试条件。仅依赖 Python 标准库。"""
from pathlib import Path
import hashlib
import json
from io import BytesIO
from decimal import Decimal, ROUND_HALF_UP
import re
import zipfile
import xml.etree.ElementTree as ET

EXPERIMENT = Path(__file__).resolve().parents[1]
DOCS = EXPERIMENT / "docs"
OUT = EXPERIMENT / "content" / "source"
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
}
VERSION = 'sh-source-2026-10-19-v2'


def read_workbook(data):
    """读取OOXML中的原始单元格、公式、合并范围和时间显示，不依赖预览图片。"""
    with zipfile.ZipFile(BytesIO(data)) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [text(si, 's') for si in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        formats, styles = {}, []
        if 'xl/styles.xml' in archive.namelist():
            style = ET.fromstring(archive.read('xl/styles.xml'))
            formats = {int(n.get('numFmtId')): n.get('formatCode', '') for n in style.findall('s:numFmts/s:numFmt', NS)}
            styles = [int(x.get('numFmtId', '0')) for x in style.findall('s:cellXfs/s:xf', NS)]
        rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        result = []
        for sheet in ET.fromstring(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            member = rels[sheet.get(f"{{{NS['r']}}}id")]
            member = member.lstrip('/') if member.startswith('/') else f'xl/{member}'
            root = ET.fromstring(archive.read(member)); cells = {}
            for cell in root.findall('s:sheetData/s:row/s:c', NS):
                value_node = cell.find('s:v', NS)
                if cell.get('t') == 'inlineStr':
                    value = text(cell, 's')
                elif value_node is not None and value_node.text is not None:
                    value = strings[int(value_node.text)] if cell.get('t') == 's' else value_node.text
                else:
                    continue
                record = {'value': value, 'display': value}
                style_id = int(cell.get('s', '0'))
                num_format = styles[style_id] if style_id < len(styles) else 0
                code = formats.get(num_format, '').lower()
                if cell.get('t') not in {'s', 'inlineStr'} and (num_format in {18, 19, 20, 21, 45, 46, 47} or ('h' in code and 'm' in code)):
                    seconds = int((Decimal(value) * 86400).to_integral_value(rounding=ROUND_HALF_UP)) % 86400
                    record['display'] = f'{seconds // 3600}:{seconds % 3600 // 60:02}'
                    record['number_format'] = code or str(num_format)
                formula = cell.find('s:f', NS)
                if formula is not None:
                    record['formula'] = formula.text
                cells[cell.get('r')] = record
            result.append({'name': sheet.get('name'), 'cells': cells,
                           'merged_ranges': [m.get('ref') for m in root.findall('s:mergeCells/s:mergeCell', NS)]})
        return result


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def text(element, prefix):
    return "".join(t.text or "" for t in element.findall(f".//{prefix}:t", NS))


def extract_docx(path):
    with zipfile.ZipFile(path) as archive:
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(archive.read("word/_rels/document.xml.rels"))}

        def paragraph(p):
            refs = []
            for image in p.findall(".//v:imagedata", NS) + p.findall(".//a:blip", NS):
                rid = image.get(f"{{{NS['r']}}}id") or image.get(f"{{{NS['r']}}}embed")
                target = rels.get(rid, "")
                if target.startswith("media/"):
                    ref = f"assets/{Path(target).name}"
                    if ref not in refs:
                        refs.append(ref)
            embedded_refs = [rels.get(obj.get(f"{{{NS['r']}}}id")) for obj in p.findall('.//o:OLEObject', NS)]
            return {"text": text(p, "w"), "image_refs": refs, 'embedded_refs': [ref for ref in embedded_refs if ref]}

        blocks = []
        body = ET.fromstring(archive.read("word/document.xml")).find("w:body", NS)
        for index, block in enumerate(body):
            if block.tag == f"{{{NS['w']}}}p":
                blocks.append({"block_index": index, "type": "paragraph", **paragraph(block)})
            elif block.tag == f"{{{NS['w']}}}tbl":
                rows = [[{"paragraphs": [paragraph(p) for p in cell.findall("w:p", NS)]}
                         for cell in row.findall("w:tc", NS)] for row in block.findall("w:tr", NS)]
                blocks.append({"block_index": index, "type": "table", "rows": rows})
        assets = []
        for name in sorted(n for n in archive.namelist() if n.startswith("word/media/")):
            target = OUT / "assets" / Path(name).name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
            assets.append(str(target.relative_to(OUT)))
        workbooks = []
        for name in sorted(n for n in archive.namelist() if n.startswith('word/embeddings/') and n.endswith('.xlsx')):
            data = archive.read(name)
            target = OUT / 'embedded' / Path(name).name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            workbooks.append({'source_member': name, 'sha256': hashlib.sha256(data).hexdigest(), 'sheets': read_workbook(data)})
        save(OUT / 'embedded-workbooks.json', {'source_file': path.name, 'workbooks': workbooks})
        result = {"source_file": path.name, "blocks": blocks, "assets": assets, 'embedded_workbook_count': len(workbooks)}
        save(OUT / "task-document.json", result)
        return result


def extract_xlsx(path):
    sheets = read_workbook(path.read_bytes())
    save(OUT / "stimulus-workbook.json", {"source_file": path.name, "sheets": sheets})
    return {s["name"]: s["cells"] for s in sheets}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    document = extract_docx(DOCS / "A5 SH任务pilot.docx")
    workbook = extract_xlsx(DOCS / "刺激材料的属性判断.xlsx")
    # 眼镜消息stimuli.json不在此生成：它含批准修订（V2新增消息、不确定项统一文案、2026-10-29文字修订），
    # 由 build_task_content.py 依据 stimulus-workbook.json 与 revisions.json 生成，避免重跑本脚本覆盖。
    matrix = workbook["每个场景中的试次顺序安排"]
    participants = []
    for version, col in enumerate("CDEFG", 1):
        id_range = matrix[f"{col}8"]["value"]
        first, last = [int(i) for i in re.findall(r"\d+", id_range)]
        stages = []
        for row in range(3, 8):
            raw = matrix[f"{col}{row}"]["value"]
            stage_id = matrix[f"B{row}"]["value"]
            if raw == "无信息介入":
                condition, message_id = "NONE", None
            else:
                message_id, timing = raw.split("-")
                condition = f"{message_id[0]}-{timing}"
            entry = {"stage_id": stage_id, "condition": condition, "message_id": message_id,
                     "source_value": raw, "source_cell": f"{col}{row}"}
            if message_id:
                entry["display_mode"] = "legacy_8500"  # 原工作簿对应旧的固定8.5秒呈现；NONE组无消息，不写。
            stages.append(entry)
        for participant_id in range(first, last + 1):
            participants.append({"participant_id": f"{participant_id:03}", "version_label": f"V{version}", "stages": stages})
    config = {"experiment_id": "f5-sh-pilot", "schema_version": "1.0",
              "source_ref": {"file": "刺激材料的属性判断.xlsx", "sheet": "每个场景中的试次顺序安排", "range": "B2:G8"},
              "participants": participants}
    save(EXPERIMENT / "config" / "participants.source.json", config)
    # 默认预分配由实验配置独立维护；重新提取原表不覆盖 participants.pilot.json。
    source_files = [p for p in sorted(DOCS.iterdir())
                    if p.is_file() and (p.name == "PRD.md" or p.suffix in {".docx", ".xlsx"})]
    files = [{"path": str(p.relative_to(EXPERIMENT)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size}
             for p in source_files]
    save(OUT / "manifest.json", {"content_version": VERSION, "files": files,
         "native_table_count": sum(b["type"] == "table" for b in document["blocks"]),
         "image_count": len(document["assets"]), "sheet_names": list(workbook),
         'embedded_workbook_count': document['embedded_workbook_count'],
         "task_data_status": "embedded_workbooks_extracted"})
    print(f"已提取 {document['embedded_workbook_count']} 份内嵌原始Excel、{len(workbook)} 张刺激工作表和{len(participants)}名预分配被试（stimuli.json 由 build_task_content.py 生成）。")


if __name__ == "__main__":
    main()
