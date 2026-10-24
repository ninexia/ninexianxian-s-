# -*- coding: utf-8 -*-
"""DOCX renderer / inspector for the DSH report-docx plugin.

Invoked by the Host plugin as:
    python report_tool.py render <request.json>
    python report_tool.py inspect <request.json>
    python report_tool.py scan <request.json>
    python report_tool.py info

Every command prints exactly one UTF-8 JSON object to stdout. Expected failures
are returned as {"ok": false, "error": "..."} so the caller can present a
structured tool error instead of parsing a traceback.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import sys
import traceback
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor
    from docx.table import Table
    from docx.text.paragraph import Paragraph
except ImportError:  # bundled runtime fallback
    _candidates = [
        Path.home() / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "python" / "Lib" / "site-packages",
        Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")) / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "python" / "Lib" / "site-packages",
    ]
    for _candidate in _candidates:
        if _candidate.exists():
            sys.path.insert(0, str(_candidate))
    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor
    from docx.table import Table
    from docx.text.paragraph import Paragraph

ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}
HEADING_STYLE = {1: "Heading 1", 2: "Heading 2", 3: "Heading 3"}
DEFAULT_FONT = {"latin": "Times New Roman", "eastAsia": "宋体", "size": 10.5}
CAPTION_FONT = {"latin": "Times New Roman", "eastAsia": "楷体", "size": 9, "bold": True, "align": "center"}
CODE_FONT = {"latin": "Consolas", "eastAsia": "宋体", "size": 9}
CAPTION_RE = re.compile(r"^\s*[表图]\s*\d+")
CHINESE_HEADING_RE = re.compile(r"^\s*(?:[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十0-9]+[章节部分]|附录)")
NUMBER_HEADING_RE = re.compile(r"^\s*(?:\d+(?:\.\d+){1,3}\s+\S|\d+[、]\s*\S)")
PLACEHOLDER_RE = re.compile(r"(【待补充|TODO|\{\{|lorem ipsum)", re.I)


_RESULT_PATH = None


def _json(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if _RESULT_PATH:
        Path(_RESULT_PATH).parent.mkdir(parents=True, exist_ok=True)
        Path(_RESULT_PATH).write_text(data + "\n", encoding="utf-8")
    else:
        sys.stdout.write(data)
        sys.stdout.write("\n")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _normal(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\t\u00a0]+", " ", text)
    text = re.sub(r"[ \u3000]{2,}", " ", text)
    return text.strip()


def _word_count(text: str) -> int:
    chinese = len(re.findall(r"[\u3400-\u9fff]", text or ""))
    latin = len(re.findall(r"[A-Za-z0-9][A-Za-z0-9_.+#/-]*", text or ""))
    return chinese + latin


def _set_run(run, spec, bold=None, color=None):
    spec = spec or {}
    run.font.name = spec.get("latin") or DEFAULT_FONT["latin"]
    run.font.size = Pt(float(spec.get("size") or DEFAULT_FONT["size"]))
    if bold is not None:
        run.bold = bold
    elif "bold" in spec:
        run.bold = bool(spec.get("bold"))
    if color:
        run.font.color.rgb = RGBColor(*color)
    east = spec.get("eastAsia") or DEFAULT_FONT["eastAsia"]
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), east)
    rfonts.set(qn("w:ascii"), spec.get("latin") or DEFAULT_FONT["latin"])
    rfonts.set(qn("w:hAnsi"), spec.get("latin") or DEFAULT_FONT["latin"])


def _set_para(p, spec, default_align="justify"):
    spec = spec or {}
    pf = p.paragraph_format
    if spec.get("lineSpacing"):
        pf.line_spacing = float(spec["lineSpacing"])
    if spec.get("spaceBefore") is not None:
        pf.space_before = Pt(float(spec["spaceBefore"]))
    if spec.get("spaceAfter") is not None:
        pf.space_after = Pt(float(spec["spaceAfter"]))
    if spec.get("firstLineIndent"):
        pf.first_line_indent = Inches(float(spec["firstLineIndent"]))
    pf.keep_with_next = bool(spec.get("keepWithNext"))
    p.alignment = ALIGN.get(spec.get("align") or default_align, WD_ALIGN_PARAGRAPH.JUSTIFY)


def _add_rich_text(p, text, spec, bold=False):
    """Minimal inline markup: **bold** and `code`."""
    pattern = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`)")
    cursor = 0
    for match in pattern.finditer(text or ""):
        if match.start() > cursor:
            _set_run(p.add_run(text[cursor:match.start()]), spec, bold=bold)
        token = match.group(0)
        if token.startswith("**"):
            _set_run(p.add_run(token[2:-2]), spec, bold=True)
        else:
            code_spec = {**spec, "latin": "Consolas", "eastAsia": "宋体", "size": min(float(spec.get("size") or 10.5), 9.5)}
            _set_run(p.add_run(token[1:-1]), code_spec, bold=False)
        cursor = match.end()
    if cursor < len(text or ""):
        _set_run(p.add_run(text[cursor:]), spec, bold=bold)


def _shade(cell_or_paragraph, fill):
    if not fill:
        return
    element = cell_or_paragraph._element
    pr = element.get_or_add_tcPr() if hasattr(element, "get_or_add_tcPr") else element.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill.lstrip("#"))
    pr.append(shd)


def _cell_margins(table, top=40, bottom=40, left=80, right=80):
    tbl_pr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for name, value in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        node = OxmlElement(f"w:{name}")
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tbl_pr.append(mar)


def _repeat_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)


def _page_field(paragraph, prefix="第 ", suffix=" 页"):
    if prefix:
        _set_run(paragraph.add_run(prefix), {"latin": "Times New Roman", "eastAsia": "宋体", "size": 9})
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr, separate, text, end):
        run._r.append(node)
    if suffix:
        _set_run(paragraph.add_run(suffix), {"latin": "Times New Roman", "eastAsia": "宋体", "size": 9})


def _toc_field(paragraph):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = ' TOC \\o "1-3" \\h \\z \\u '
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    placeholder = OxmlElement("w:t")
    placeholder.text = "右键“更新域”生成目录"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr, separate, placeholder, end):
        run._r.append(node)
    _set_run(run, {"latin": "Times New Roman", "eastAsia": "宋体", "size": 10.5})


def _set_update_fields(doc):
    settings = doc.settings.element
    node = settings.find(qn("w:updateFields"))
    if node is None:
        node = OxmlElement("w:updateFields")
        settings.append(node)
    node.set(qn("w:val"), "true")


class Renderer:
    def __init__(self, payload):
        self.payload = payload
        self.template = payload.get("template") or {}
        self.styles = self.template.get("styles") or {}
        self.cover = payload.get("cover") or {}
        self.meta = payload.get("meta") or {}
        self.sections = payload.get("sections") or []
        self.warnings = []
        self.caption_counter = {"table": 0, "figure": 0}
        self.doc = Document()
        self.available_width = 6.0

    def build(self):
        self._page()
        self._styles()
        self._properties()
        self._header_footer()
        if self.cover.get("enabled", True):
            self._cover()
        if (self.payload.get("toc") or {}).get("enabled"):
            self._toc()
        for section in self.sections:
            self._section(section)
        self.doc.save(self.payload["output"])
        return {
            "ok": True,
            "output": self.payload["output"],
            "bytes": os.path.getsize(self.payload["output"]),
            "warnings": self.warnings,
            "sections": len(self.sections),
        }

    def _page(self):
        page = self.template.get("page") or {}
        section = self.doc.sections[0]
        width = Inches(8.27) if page.get("size", "A4") == "A4" else Inches(8.5)
        height = Inches(11.69) if page.get("size", "A4") == "A4" else Inches(11.0)
        if page.get("orientation") == "landscape":
            section.orientation = WD_ORIENT.LANDSCAPE
            width, height = height, width
        else:
            section.orientation = WD_ORIENT.PORTRAIT
        section.page_width = width
        section.page_height = height
        margins = page.get("margins") or {}
        section.top_margin = Inches(float(margins.get("top", 1.0)))
        section.bottom_margin = Inches(float(margins.get("bottom", 1.0)))
        section.left_margin = Inches(float(margins.get("left", 1.1)))
        section.right_margin = Inches(float(margins.get("right", 1.1)))
        section.header_distance = Inches(float(page.get("headerDistance", 0.45)))
        section.footer_distance = Inches(float(page.get("footerDistance", 0.45)))
        self.available_width = width.inches - section.left_margin.inches - section.right_margin.inches

    def _styles(self):
        normal = self.doc.styles["Normal"]
        body = {**DEFAULT_FONT, **(self.styles.get("body") or {})}
        normal.font.name = body.get("latin", DEFAULT_FONT["latin"])
        normal.font.size = Pt(float(body.get("size", DEFAULT_FONT["size"])))
        rpr = normal.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = OxmlElement("w:rFonts")
            rpr.append(rfonts)
        rfonts.set(qn("w:eastAsia"), body.get("eastAsia", "宋体"))
        normal.paragraph_format.space_after = Pt(float(body.get("spaceAfter", 4)))
        normal.paragraph_format.line_spacing = float(body.get("lineSpacing", 1.3))
        for level, name in HEADING_STYLE.items():
            style = self.doc.styles[name]
            spec = self.styles.get(f"h{level}") or {}
            style.font.name = spec.get("latin", "Times New Roman")
            style.font.size = Pt(float(spec.get("size", {1: 15, 2: 13, 3: 12}[level])))
            style.font.bold = bool(spec.get("bold", True))
            style.paragraph_format.space_before = Pt(float(spec.get("spaceBefore", 8)))
            style.paragraph_format.space_after = Pt(float(spec.get("spaceAfter", 4)))
            style.paragraph_format.keep_with_next = bool(spec.get("keepWithNext", True))
            srpr = style.element.get_or_add_rPr()
            srfonts = srpr.find(qn("w:rFonts"))
            if srfonts is None:
                srfonts = OxmlElement("w:rFonts")
                srpr.append(srfonts)
            srfonts.set(qn("w:eastAsia"), spec.get("eastAsia", "黑体"))

    def _properties(self):
        props = self.doc.core_properties
        title = _normal(self.meta.get("title") or "实验报告")
        props.title = title
        props.subject = _normal(self.meta.get("course") or "")
        props.author = "DSH report-docx"
        props.comments = f"template={self.meta.get('templateId', '')}; plan={self.meta.get('planId', '')}"
        props.created = _dt.datetime.now()
        props.modified = _dt.datetime.now()

    def _header_footer(self):
        section = self.doc.sections[0]
        section.different_first_page_header_footer = True
        options = self.payload.get("options") or {}
        header_text = _normal(options.get("headerText") or "")
        if options.get("addHeader", True) and header_text:
            header_text = header_text.replace("{{course}}", self.meta.get("course", "")).replace("{{experiment}}", self.meta.get("experiment", ""))
            p = section.header.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _set_run(p.add_run(header_text), {"latin": "Times New Roman", "eastAsia": "宋体", "size": 9}, color=(0x55, 0x55, 0x55))
            p_pr = p._p.get_or_add_pPr()
            border = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "4")
            bottom.set(qn("w:space"), "1")
            bottom.set(qn("w:color"), "BFBFBF")
            border.append(bottom)
            p_pr.append(border)
        if options.get("addPageNumbers", True):
            p = section.footer.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _page_field(p)

    def _cover(self):
        fields = {field["key"]: field.get("value", "") for field in self.cover.get("fields") or []}
        spacer = int(self.cover.get("spacerLines") or 3)
        for _ in range(spacer):
            self.doc.add_paragraph()
        course = fields.get("course") or self.meta.get("course") or ""
        semester = fields.get("semester") or ""
        experiment = fields.get("experiment") or self.meta.get("experiment") or self.meta.get("title") or ""
        if course:
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _set_run(p.add_run(course), {"latin": "Times New Roman", "eastAsia": "宋体", "size": float(self.cover.get("courseSize", 26))}, bold=False)
            p.paragraph_format.space_after = Pt(8)
        if semester:
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _set_run(p.add_run(semester), {"latin": "Times New Roman", "eastAsia": "宋体", "size": float(self.cover.get("semesterSize", 18))}, bold=True)
            p.paragraph_format.space_after = Pt(20)
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(24)
        p.paragraph_format.space_after = Pt(36)
        _set_run(p.add_run(experiment), {"latin": "Times New Roman", "eastAsia": "黑体", "size": float(self.cover.get("titleSize", 22))}, bold=True)

        skip = {"course", "semester", "experiment", "college"}
        info_fields = [field for field in self.cover.get("fields") or [] if field["key"] not in skip]
        for field in info_fields:
            value = fields.get(field["key"]) or ("＿＿＿＿" if field.get("required") else "")
            if not value and not field.get("required"):
                continue
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_after = Pt(7)
            _add_rich_text(p, f"{field.get('label', field['key'])}：{value}", {"latin": "Times New Roman", "eastAsia": "宋体", "size": float(self.cover.get("infoSize", 14))}, bold=False)

        college = fields.get("college") or ""
        if college:
            self.doc.add_paragraph()
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _set_run(p.add_run(college), {"latin": "Times New Roman", "eastAsia": "宋体", "size": float(self.cover.get("collegeSize", 14))}, bold=True)
        self.doc.add_page_break()

    def _toc(self):
        toc = self.payload.get("toc") or {}
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(12)
        _set_run(p.add_run(toc.get("title") or "目　　录"), {"latin": "Times New Roman", "eastAsia": "黑体", "size": 18}, bold=True)
        body = _normal(self.styles.get("body", {}).get("eastAsia", "宋体"))
        for _ in range(3):
            line = self.doc.add_paragraph()
            _set_run(line.add_run("　"), {"latin": "Times New Roman", "eastAsia": body, "size": 10.5})
        _toc_field(self.doc.add_paragraph())
        _set_update_fields(self.doc)
        self.doc.add_page_break()

    def _section(self, section):
        level = int(section.get("level") or 1)
        heading = self.doc.add_heading(level=level)
        style = self.styles.get(f"h{level}") or {}
        heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
        heading.paragraph_format.keep_with_next = True
        _add_rich_text(heading, _normal(section.get("title") or ""), style, bold=True)
        for block in section.get("blocks") or []:
            kind = block.get("type")
            if kind == "paragraph":
                self._paragraph(block.get("text", ""))
            elif kind == "bullets":
                self._list(block.get("items") or [], numbered=False)
            elif kind == "numbered":
                self._list(block.get("items") or [], numbered=True)
            elif kind == "table":
                self._table(block)
            elif kind == "image":
                self._image(block)
            elif kind == "code":
                self._code(block)
            elif kind == "note":
                self._paragraph(block.get("text", ""), note=True)
            elif kind == "pagebreak":
                self.doc.add_page_break()

    def _paragraph(self, text, note=False):
        text = _normal(text)
        if not text:
            return
        p = self.doc.add_paragraph()
        spec = self.styles.get("body") or {}
        _set_para(p, spec)
        if note:
            _set_run(p.add_run("注："), {**spec, "bold": True})
        _add_rich_text(p, text, spec, bold=False)

    def _list(self, items, numbered):
        spec = self.styles.get("body") or {}
        for index, item in enumerate(items, start=1):
            text = _normal(item)
            if not text:
                continue
            p = self.doc.add_paragraph()
            _set_para(p, {**spec, "firstLineIndent": 0})
            p.paragraph_format.left_indent = Inches(0.28)
            p.paragraph_format.first_line_indent = Inches(-0.2)
            p.paragraph_format.space_after = Pt(2)
            prefix = f"{index}. " if numbered else "• "
            _add_rich_text(p, prefix + text, spec, bold=False)

    def _caption(self, text, kind):
        text = _normal(text)
        if not text:
            return
        if not CAPTION_RE.match(text):
            self.caption_counter[kind] += 1
            prefix = "表" if kind == "table" else "图"
            text = f"{prefix}{self.caption_counter[kind]}  {text}"
        p = self.doc.add_paragraph()
        spec = {**CAPTION_FONT, **(self.styles.get("caption") or {})}
        _set_para(p, spec, default_align="center")
        _add_rich_text(p, text, spec, bold=True)
        if kind == "table":
            p.paragraph_format.keep_with_next = True

    def _table(self, block):
        rows = block.get("rows") or []
        headers = block.get("headers") or []
        if not rows and not headers:
            return
        if block.get("caption"):
            self._caption(block["caption"], "table")
        width = len(headers) or max((len(row) for row in rows), default=1)
        table = self.doc.add_table(rows=1 if headers else 0, cols=width)
        table.style = "Table Grid"
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = not bool(block.get("widths"))
        spec = {**(self.styles.get("table") or {}), "size": float(block.get("fontSize") or self.styles.get("table", {}).get("size", 9))}
        if headers:
            row = table.rows[0]
            _repeat_header(row)
            for index, value in enumerate(headers):
                cell = row.cells[index]
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                _shade(cell, block.get("headerFill") or "E7E6E6")
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_after = Pt(0)
                _set_run(p.add_run(_normal(value)), spec, bold=True)
        for values in rows:
            row = table.add_row()
            for index in range(width):
                cell = row.cells[index]
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = Pt(0)
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                _add_rich_text(p, _normal(values[index] if index < len(values) else ""), spec, bold=False)
        widths = block.get("widths") or []
        if widths:
            for index, inches in enumerate(widths[:width]):
                for row in table.rows:
                    row.cells[index].width = Inches(float(inches))
        else:
            each = self.available_width / max(width, 1)
            for index in range(width):
                for row in table.rows:
                    row.cells[index].width = Inches(each)
        _cell_margins(table)
        spacer = self.doc.add_paragraph()
        spacer.paragraph_format.space_after = Pt(2)
        spacer.paragraph_format.line_spacing = 1.0

    def _image(self, block):
        path = block.get("path") or ""
        caption = block.get("caption") or ""
        try:
            if not path or not os.path.exists(path) or block.get("missing"):
                raise FileNotFoundError(path)
            width = float(block.get("width") or 5.6)
            width = max(1.0, min(width, self.available_width))
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.keep_with_next = True
            run = p.add_run()
            run.add_picture(path, width=Inches(width))
            if caption:
                self._caption(caption, "figure")
        except Exception as exc:
            self.warnings.append(f"image unavailable: {path}: {exc}")
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _set_run(p.add_run(f"【图片缺失：{os.path.basename(path) or path}】"), {"latin": "Times New Roman", "eastAsia": "宋体", "size": 9}, color=(0xB0, 0x00, 0x00))

    def _code(self, block):
        text = (block.get("text") or "").replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
        if not text:
            return
        if block.get("caption"):
            self._caption(block["caption"], "table")
        spec = {**CODE_FONT, **(self.styles.get("code") or {})}
        for line in text.split("\n"):
            p = self.doc.add_paragraph()
            _set_para(p, {**spec, "spaceBefore": 0, "spaceAfter": 0, "lineSpacing": 1.0, "align": "left"})
            p.paragraph_format.left_indent = Inches(0.1)
            _shade(p, "F4F5F7")
            run = p.add_run(line if line else " ")
            _set_run(run, spec)
        spacer = self.doc.add_paragraph()
        spacer.paragraph_format.space_after = Pt(2)
        spacer.paragraph_format.line_spacing = 1.0


def render(request):
    output = request.get("output")
    if not output:
        return {"ok": False, "error": "missing output path"}
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    renderer = Renderer(request)
    result = renderer.build()
    inspect_result = inspect_path(output)
    result["inspect"] = inspect_result
    return result


def _heading_level(paragraph):
    style = (paragraph.style.name if paragraph.style else "") or ""
    match = re.match(r"(?:Heading|标题)\s*([1-9])", style, re.I)
    if match:
        return int(match.group(1))
    text = _normal(paragraph.text)
    if style.lower().startswith("toc"):
        return 0
    if CHINESE_HEADING_RE.match(text):
        return 1
    numbered = NUMBER_HEADING_RE.match(text)
    if numbered:
        depth = text.split(" ")[0].count(".") + 1
        return min(3, depth)
    return 0


def inspect_path(path):
    try:
        doc = Document(path)
    except Exception as exc:
        return {"ok": False, "path": path, "error": f"cannot open DOCX: {exc}"}
    paragraphs = []
    headings = []
    sections = []
    stack = []
    table_texts = []
    index = 0
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            paragraph = Paragraph(child, doc)
            text = _normal(paragraph.text)
            if not text:
                continue
            level = _heading_level(paragraph)
            paragraphs.append({"index": index, "text": text, "level": level, "style": paragraph.style.name if paragraph.style else ""})
            if level:
                headings.append({"text": text, "level": level, "style": paragraph.style.name if paragraph.style else ""})
                while stack and stack[-1]["level"] >= level:
                    stack.pop()
                current = {"title": text, "level": level, "words": 0, "paragraphs": 0, "tables": 0, "images": 0}
                sections.append(current)
                stack.append(current)
            elif stack:
                for open_section in stack:
                    open_section["words"] += _word_count(text)
                    open_section["paragraphs"] += 1
            index += 1
        elif child.tag == qn("w:tbl"):
            table = Table(child, doc)
            table_text = " ".join(_normal(cell.text) for row in table.rows for cell in row.cells)
            table_texts.append(table_text)
            if stack:
                for open_section in stack:
                    open_section["words"] += _word_count(table_text)
                stack[-1]["tables"] += 1

    full_text = "\n".join([*(item["text"] for item in paragraphs), *table_texts])
    normalized = [re.sub(r"\s+", "", item["text"]).lower() for item in paragraphs if len(item["text"]) >= 12]
    duplicate = len(normalized) - len(set(normalized))
    duplicate_ratio = duplicate / max(len(normalized), 1)

    long_paragraphs = [
        {"index": item["index"], "chars": len(item["text"])}
        for item in paragraphs
        if item["level"] == 0 and len(item["text"]) > 200
    ]
    section = doc.sections[0] if doc.sections else None
    return {
        "ok": True,
        "path": path,
        "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
        "paragraphs": len(doc.paragraphs),
        "tables": len(doc.tables),
        "images": len(doc.inline_shapes),
        "words": _word_count(full_text),
        "chineseChars": len(re.findall(r"[\u3400-\u9fff]", full_text)),
        "headings": headings,
        "sections": sections,
        "duplicateRatio": round(duplicate_ratio, 4),
        "duplicates": duplicate,
        "placeholders": sorted(set(PLACEHOLDER_RE.findall(full_text))),
        "longParagraphs": long_paragraphs[:20],
        "text": full_text,
        "page": {
            "width": round(section.page_width.inches, 2) if section and section.page_width else None,
            "height": round(section.page_height.inches, 2) if section and section.page_height else None,
            "leftMargin": round(section.left_margin.inches, 2) if section and section.left_margin else None,
        },
    }


def scan(request):
    paths = request.get("paths") or []
    docs = []
    errors = []
    for path in paths[:500]:
        try:
            info = inspect_path(path)
            if not info.get("ok"):
                errors.append(info)
                continue
            text = info.pop("text", "")
            first = next((p["text"] for p in info.get("headings", []) if p["text"]), "")
            if not first:
                first = next((line.strip() for line in text.split("\n") if line.strip()), "")
            docs.append({
                "path": os.path.abspath(path),
                "sha256": _sha256_bytes(Path(path).read_bytes()),
                "bytes": info.get("bytes", 0),
                "paragraphs": info.get("paragraphs", 0),
                "tables": info.get("tables", 0),
                "images": info.get("images", 0),
                "words": info.get("words", 0),
                "title": _normal(first)[:100],
                "headings": info.get("headings", [])[:80],
                "sections": info.get("sections", [])[:40],
                "page": info.get("page"),
                "duplicateRatio": info.get("duplicateRatio", 0),
            })
        except Exception as exc:
            errors.append({"path": path, "error": str(exc)})
    return {"ok": True, "docs": docs, "errors": errors, "count": len(docs)}


def info():
    return {
        "ok": True,
        "python": sys.version,
        "executable": sys.executable,
        "pythonDocx": getattr(__import__("docx"), "__version__", "unknown"),
        "platform": sys.platform,
        "features": ["render", "inspect", "scan"],
    }


def main(argv):
    global _RESULT_PATH
    if len(argv) >= 4:
        _RESULT_PATH = argv[3]
    if len(argv) < 2:
        _json({"ok": False, "error": "usage: report_tool.py <render|inspect|scan|info> [request.json] [result.json]"})
        return 0
    command = argv[1]
    try:
        if command == "info":
            _json(info())
            return 0
        if len(argv) < 3:
            _json({"ok": False, "error": f"missing request path for {command}"})
            return 0
        request = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
        if command == "render":
            _json(render(request))
        elif command == "inspect":
            _json(inspect_path(request.get("path", "")))
        elif command == "scan":
            _json(scan(request))
        else:
            _json({"ok": False, "error": f"unknown command: {command}"})
    except Exception as exc:
        _json({"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-4000:]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
