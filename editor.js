/**
 * editor.js
 * 1. Student Rich-Text Methodology Editor & Safe DOM Sanitiser
 * 2. Lecturer Word-Style Review & Rich-Text Studio:
 *    - Full Home/Insert formatting ribbon + Undo/Redo snapshot history
 *    - Automatic Track Changes interception (typing, Backspace, Delete, Paste, Cut, selection overwrite)
 *    - Word Markup Views (All Markup, Simple Markup, No Markup, Original)
 *    - Prev/Next change navigation + Accept/Reject single or all tracked revisions
 */
(function (global) {
  'use strict';

  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'U', 'SUB', 'SUP',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
    'INS', 'DEL', 'MARK', 'SPAN', 'HR'
  ]);

  const ALLOWED_ATTRS = {
    INS: ['class', 'data-rev-id'],
    DEL: ['class', 'data-rev-id'],
    MARK: ['class', 'data-tag'],
    SPAN: ['class', 'data-comment-id'],
    TH: ['colspan', 'rowspan'],
    TD: ['colspan', 'rowspan']
  };

  const SYMBOLS = [
    'α', 'β', 'χ²', 'η²', 'μ', 'σ', 'Δ', '±', '≤', '≥', '≠', 'p < .05', 'p < .001', 'R²', 'N = ', 'n = '
  ];

  const SCAFFOLDS = {
    rq: '<h3>Research Questions &amp; Hypotheses</h3><p><strong>RQ1:</strong> To what extent does [independent construct] predict [dependent outcome] among [target population]?</p><p><strong>H1:</strong> Higher levels of [construct A] will be positively associated with [construct B], controlling for [covariate].</p>',
    variables: '<h3>Construct Operationalisation Matrix</h3><table><thead><tr><th>Construct / Variable</th><th>Conceptual Definition</th><th>Measurement / Indicator</th><th>Scale / Coding</th></tr></thead><tbody><tr><td>[Independent Variable]</td><td>[Theoretical definition]</td><td>[Instrument / Item]</td><td>[e.g. 5-point Likert]</td></tr><tr><td>[Dependent Variable]</td><td>[Theoretical definition]</td><td>[Task / Observation]</td><td>[Continuous score]</td></tr></tbody></table><p></p>',
    sampling: '<h3>Participants, Sampling &amp; Ethics</h3><p>Using purposive criterion sampling, this study recruits [<em>n</em> = ...] participants from [institutional/social context]. Inclusion criteria require that participants [criterion 1] and [criterion 2]. Informed consent and pseudonymisation protocols are observed throughout.</p>',
    qualitative: '<h3>Analytic Claim &amp; Data Excerpt</h3><p>[State interpretive claim linking participant account to theoretical framework.]</p><blockquote>&ldquo;[Insert anonymised interview or reflective journal excerpt here.]&rdquo; (Participant 04, Interview 1)</blockquote><p>[Unpack specific discursive or thematic features in the excerpt above.]</p>'
  };

  let revCounter = 0;
  function nextRevId() {
    revCounter += 1;
    return 'rev_' + Date.now().toString(36) + '_' + revCounter;
  }

  function sanitiseHtml(dirtyHtml) {
    if (!dirtyHtml) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(dirtyHtml), 'text/html');

    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.nodeValue);
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return null;
      }

      const tag = node.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') {
        return null;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        const frag = document.createDocumentFragment();
        Array.from(node.childNodes).forEach(function (child) {
          const cleaned = cleanNode(child);
          if (cleaned) frag.appendChild(cleaned);
        });
        if (tag === 'DIV') {
          const p = document.createElement('p');
          p.appendChild(frag);
          return p;
        }
        return frag;
      }

      const cleanEl = document.createElement(tag.toLowerCase());
      const permittedAttrs = ALLOWED_ATTRS[tag] || [];
      permittedAttrs.forEach(function (attr) {
        if (node.hasAttribute(attr)) {
          let val = node.getAttribute(attr);
          if (attr === 'class') {
            val = val.replace(/\brev-focused\b/g, '').trim();
          }
          if (val) cleanEl.setAttribute(attr, val);
        }
      });

      Array.from(node.childNodes).forEach(function (child) {
        const cleanedChild = cleanNode(child);
        if (cleanedChild) cleanEl.appendChild(cleanedChild);
      });
      return cleanEl;
    }

    const out = document.createElement('div');
    Array.from(doc.body.childNodes).forEach(function (n) {
      const cleaned = cleanNode(n);
      if (cleaned) out.appendChild(cleaned);
    });
    return out.innerHTML;
  }

  function countWordsFromText(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 0;
    return cleaned.split(' ').length;
  }

  /**
   * Counts effective words (excluding struck-out <del> text so word count reflects the revised prose).
   */
  function countWordsFromHtml(html) {
    if (!html) return 0;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('del.rev-del').forEach(function (d) { d.remove(); });
    return countWordsFromText(tmp.innerText || tmp.textContent || '');
  }

  function buildTableHtml(rows, cols) {
    const rCount = Math.max(1, Math.min(12, Number(rows) || 3));
    const cCount = Math.max(1, Math.min(8, Number(cols) || 3));
    let html = '<table><thead><tr>';
    for (let c = 0; c < cCount; c++) {
      html += '<th>Heading ' + (c + 1) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rCount - 1; r++) {
      html += '<tr>';
      for (let c = 0; c < cCount; c++) {
        html += '<td>&nbsp;</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    return html;
  }

  function selectionInside(editableEl) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editableEl.contains(range.commonAncestorContainer)) return null;
    return { sel: sel, range: range };
  }

  function unwrapElement(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
    parent.normalize();
  }

  // =========================================================
  // 1. STUDENT METHODOLOGY EDITOR
  // =========================================================
  function initStudentEditor(mountEl, opts) {
    const onChange = (opts && opts.onChange) || function () {};
    let isLocked = false;

    mountEl.innerHTML = '' +
      '<div class="editor-shell">' +
        '<div class="editor-toolbar" data-role="student-tb">' +
          '<select class="tb-select" data-action="block" title="Paragraph / Heading Style">' +
            '<option value="P">Paragraph</option>' +
            '<option value="H2">Section Heading (H2)</option>' +
            '<option value="H3">Sub-heading (H3)</option>' +
            '<option value="BLOCKQUOTE">Data / Literature Excerpt</option>' +
          '</select>' +
          '<span class="tb-sep"></span>' +
          '<button type="button" class="tb-btn" data-cmd="bold" title="Bold"><strong>B</strong></button>' +
          '<button type="button" class="tb-btn" data-cmd="italic" title="Italic"><em>I</em></button>' +
          '<button type="button" class="tb-btn" data-cmd="underline" title="Underline"><u>U</u></button>' +
          '<button type="button" class="tb-btn" data-cmd="subscript" title="Subscript">x<sub>i</sub></button>' +
          '<button type="button" class="tb-btn" data-cmd="superscript" title="Superscript">R<sup>2</sup></button>' +
          '<span class="tb-sep"></span>' +
          '<button type="button" class="tb-btn" data-cmd="insertUnorderedList" title="Bulleted List">&bull; List</button>' +
          '<button type="button" class="tb-btn" data-cmd="insertOrderedList" title="Numbered List">1. List</button>' +
          '<button type="button" class="tb-btn" data-action="table" title="Insert Research Matrix / Table">+ Table</button>' +
          '<button type="button" class="tb-btn" data-action="symbols" title="Toggle Statistical &amp; Greek Symbols">&alpha;/&chi;&sup2;</button>' +
          '<span class="tb-sep"></span>' +
          '<select class="tb-select" data-action="scaffold" title="Insert Methodology Text Structure">' +
            '<option value="">+ Genre Scaffold...</option>' +
            '<option value="rq">RQs &amp; Hypotheses</option>' +
            '<option value="variables">Operationalisation Table</option>' +
            '<option value="sampling">Sampling &amp; Ethics</option>' +
            '<option value="qualitative">Qualitative Excerpt &amp; Claim</option>' +
          '</select>' +
        '</div>' +
        '<div class="symbol-drawer hidden" data-role="sym-bar"></div>' +
        '<div class="academic-prose" contenteditable="true" spellcheck="true" data-role="editable"></div>' +
      '</div>';

    const toolbar = mountEl.querySelector('[data-role="student-tb"]');
    const symBar = mountEl.querySelector('[data-role="sym-bar"]');
    const editable = mountEl.querySelector('[data-role="editable"]');

    SYMBOLS.forEach(function (sym) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sym-chip';
      btn.textContent = sym;
      btn.addEventListener('click', function () {
        if (isLocked) return;
        editable.focus();
        document.execCommand('insertText', false, sym);
        onChange(getHtml());
      });
      symBar.appendChild(btn);
    });

    toolbar.addEventListener('click', function (e) {
      if (isLocked) return;
      const btn = e.target.closest('button');
      if (!btn) return;
      const cmd = btn.getAttribute('data-cmd');
      const action = btn.getAttribute('data-action');

      if (cmd) {
        editable.focus();
        document.execCommand(cmd, false, null);
        onChange(getHtml());
      } else if (action === 'table') {
        editable.focus();
        document.execCommand('insertHTML', false, buildTableHtml(3, 3));
        onChange(getHtml());
      } else if (action === 'symbols') {
        symBar.classList.toggle('hidden');
      }
    });

    toolbar.addEventListener('change', function (e) {
      if (isLocked) return;
      const sel = e.target;
      const action = sel.getAttribute('data-action');
      if (action === 'block' && sel.value) {
        editable.focus();
        document.execCommand('formatBlock', false, sel.value);
        onChange(getHtml());
      } else if (action === 'scaffold' && sel.value) {
        const template = SCAFFOLDS[sel.value];
        if (template) {
          editable.focus();
          document.execCommand('insertHTML', false, template);
          onChange(getHtml());
        }
        sel.value = '';
      }
    });

    editable.addEventListener('paste', function (e) {
      if (isLocked) return;
      e.preventDefault();
      const htmlData = e.clipboardData.getData('text/html');
      const textData = e.clipboardData.getData('text/plain');
      if (htmlData) {
        document.execCommand('insertHTML', false, sanitiseHtml(htmlData));
      } else if (textData) {
        const paras = textData.split(/\r?\n\r?\n/).map(function (t) {
          const p = document.createElement('p');
          p.textContent = t.trim();
          return p.outerHTML;
        }).join('');
        document.execCommand('insertHTML', false, paras);
      }
      onChange(getHtml());
    });

    editable.addEventListener('input', function () {
      if (!isLocked) onChange(getHtml());
    });

    function getHtml() {
      return sanitiseHtml(editable.innerHTML);
    }

    function setHtml(html) {
      editable.innerHTML = sanitiseHtml(html || '<p><br></p>');
    }

    function setLocked(locked) {
      isLocked = Boolean(locked);
      editable.setAttribute('contenteditable', isLocked ? 'false' : 'true');
      toolbar.classList.toggle('hidden', isLocked);
      if (isLocked) symBar.classList.add('hidden');
    }

    setHtml('<p><br></p>');

    return {
      getHtml: getHtml,
      setHtml: setHtml,
      setLocked: setLocked,
      countWords: function () { return countWordsFromText(editable.innerText); }
    };
  }

  // =========================================================
  // 2. LECTURER WORD-STYLE REVIEW & EDITING ENGINE
  // =========================================================
  function initAdminEditor(mountEl, opts) {
    const onChange = (opts && opts.onChange) || function () {};
    const onViewModeChange = (opts && opts.onViewModeChange) || function () {};
    const onRequestComment = (opts && opts.onRequestComment) || function () {};
    const onClickAnchor = (opts && opts.onClickAnchor) || function () {};

    let trackChanges = true;
    let viewMode = 'all-markup'; // 'all-markup' | 'simple-markup' | 'no-markup' | 'original'
    let savedRange = null;
    let focusedRevIndex = -1;

    // Undo / Redo Snapshot Stack
    let historyStack = [];
    let historyIdx = -1;
    let historyTimer = null;

    mountEl.innerHTML = '' +
      '<div class="editor-shell">' +
        '<!-- ROW 1: FULL EDITING & FORMATTING RIBBON (WORD HOME / INSERT) -->' +
        '<div class="editor-toolbar" data-role="admin-edit-tb">' +
          '<span class="ribbon-tag">Edit</span>' +
          '<button type="button" class="tb-btn" data-edit="undo" title="Undo (Ctrl+Z)">&#x21B6;</button>' +
          '<button type="button" class="tb-btn" data-edit="redo" title="Redo (Ctrl+Y)">&#x21B7;</button>' +
          '<span class="tb-sep"></span>' +
          '<select class="tb-select" data-action="block" title="Paragraph / Heading Style">' +
            '<option value="P">Paragraph</option>' +
            '<option value="H2">Heading 2</option>' +
            '<option value="H3">Heading 3</option>' +
            '<option value="BLOCKQUOTE">Blockquote</option>' +
          '</select>' +
          '<button type="button" class="tb-btn" data-cmd="bold" title="Bold (Ctrl+B)"><strong>B</strong></button>' +
          '<button type="button" class="tb-btn" data-cmd="italic" title="Italic (Ctrl+I)"><em>I</em></button>' +
          '<button type="button" class="tb-btn" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
          '<button type="button" class="tb-btn" data-cmd="subscript" title="Subscript">x<sub>i</sub></button>' +
          '<button type="button" class="tb-btn" data-cmd="superscript" title="Superscript">R<sup>2</sup></button>' +
          '<span class="tb-sep"></span>' +
          '<button type="button" class="tb-btn" data-cmd="insertUnorderedList" title="Bulleted List">&bull; List</button>' +
          '<button type="button" class="tb-btn" data-cmd="insertOrderedList" title="Numbered List">1. List</button>' +
          '<button type="button" class="tb-btn" data-edit="table" title="Insert Table">+ Table</button>' +
          '<button type="button" class="tb-btn" data-edit="symbols" title="Statistical &amp; Greek Symbols">&alpha;/&chi;&sup2;</button>' +
          '<button type="button" class="tb-btn" data-cmd="removeFormat" title="Clear Text Formatting">Tx</button>' +
        '</div>' +

        '<!-- ROW 2: WORD REVIEW RIBBON (TRACK CHANGES, MARKUP VIEW, ACCEPT/REJECT, COMMENTS) -->' +
        '<div class="review-ribbon" data-role="admin-review-tb">' +
          '<span class="ribbon-tag">Review</span>' +
          '<button type="button" class="tb-track-toggle active" data-rev="toggle-track" title="Toggle Automatic Track Changes">' +
            '<span class="track-led"></span>' +
            '<span data-role="track-label">Track Changes: ON</span>' +
          '</button>' +
          '<select class="tb-select" data-rev="view-mode" title="Markup Display Mode (Synced to Students)">' +
            '<option value="all-markup">All Markup</option>' +
            '<option value="simple-markup">Simple Markup</option>' +
            '<option value="no-markup">No Markup (Final)</option>' +
            '<option value="original">Original</option>' +
          '</select>' +
          '<span class="tb-sep"></span>' +
          '<button type="button" class="tb-btn" data-rev="prev" title="Previous Tracked Change">&#x25C0; Prev</button>' +
          '<button type="button" class="tb-btn" data-rev="next" title="Next Tracked Change">Next &#x25B6;</button>' +
          '<button type="button" class="tb-btn tb-accept" data-rev="accept" title="Accept Selected/Current Change">&check; Accept</button>' +
          '<button type="button" class="tb-btn tb-reject" data-rev="reject" title="Reject Selected/Current Change">&times; Reject</button>' +
          '<button type="button" class="tb-btn" data-rev="accept-all" title="Accept All Changes in Document">Accept All</button>' +
          '<button type="button" class="tb-btn" data-rev="reject-all" title="Reject All Changes in Document">Reject All</button>' +
          '<span class="tb-sep"></span>' +
          '<select class="tb-select" data-rev="highlight" title="Highlight Selected Text">' +
            '<option value="">Highlight...</option>' +
            '<option value="Construct Clarity">Yellow: Construct Clarity</option>' +
            '<option value="Methodological Rigour">Blue: Methodological Rigour</option>' +
            '<option value="Academic Style">Purple: Academic Style</option>' +
            '<option value="Cohesion &amp; Argument">Coral: Cohesion &amp; Argument</option>' +
            '<option value="Exemplary Move">Green: Exemplary Move</option>' +
            '<option value="__CLEAR__">Remove Highlight</option>' +
          '</select>' +
          '<button type="button" class="tb-btn tb-com" data-rev="comment" title="Attach Review Comment to Selection">+ New Comment</button>' +
        '</div>' +

        '<div class="symbol-drawer hidden" data-role="admin-sym-bar"></div>' +
        '<div class="academic-prose view-all-markup" contenteditable="true" spellcheck="true" data-role="admin-editable"></div>' +
      '</div>';

    const editToolbar = mountEl.querySelector('[data-role="admin-edit-tb"]');
    const reviewToolbar = mountEl.querySelector('[data-role="admin-review-tb"]');
    const trackBtn = reviewToolbar.querySelector('[data-rev="toggle-track"]');
    const trackLabel = reviewToolbar.querySelector('[data-role="track-label"]');
    const viewSelect = reviewToolbar.querySelector('[data-rev="view-mode"]');
    const symBar = mountEl.querySelector('[data-role="admin-sym-bar"]');
    const editable = mountEl.querySelector('[data-role="admin-editable"]');

    // Populate Statistical & Greek Symbols
    SYMBOLS.forEach(function (sym) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sym-chip';
      btn.textContent = sym;
      btn.addEventListener('click', function () {
        editable.focus();
        if (trackChanges) {
          const ctx = selectionInside(editable);
          if (ctx) {
            let r = ctx.range;
            if (!r.collapsed) r = markRangeDeleted(r, 'after');
            insertTrackedText(r, sym);
            commitEdit(true);
          }
        } else {
          document.execCommand('insertText', false, sym);
          commitEdit(true);
        }
      });
      symBar.appendChild(btn);
    });

    // =========================================================
    // SNAPSHOT UNDO / REDO HISTORY
    // =========================================================
    function pushHistory(immediate) {
      const pushNow = function () {
        const snap = sanitiseHtml(editable.innerHTML);
        if (historyIdx >= 0 && historyStack[historyIdx] === snap) return;
        historyStack = historyStack.slice(0, historyIdx + 1);
        historyStack.push(snap);
        if (historyStack.length > 60) historyStack.shift();
        historyIdx = historyStack.length - 1;
      };

      if (historyTimer) clearTimeout(historyTimer);
      if (immediate) {
        pushNow();
      } else {
        historyTimer = setTimeout(pushNow, 450);
      }
    }

    function undo() {
      if (historyIdx > 0) {
        historyIdx -= 1;
        editable.innerHTML = historyStack[historyIdx];
        notifyChanged();
      }
    }

    function redo() {
      if (historyIdx < historyStack.length - 1) {
        historyIdx += 1;
        editable.innerHTML = historyStack[historyIdx];
        notifyChanged();
      }
    }

    function commitEdit(immediateHistory) {
      mergeAdjacentRevisions();
      pushHistory(Boolean(immediateHistory));
      notifyChanged();
    }

    function notifyChanged() {
      onChange(getHtml(), getRevisionStats());
    }

    // =========================================================
    // AUTOMATIC TRACK CHANGES DOM ENGINE
    // =========================================================
    function closestRev(node, selector) {
      if (!node) return null;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !editable.contains(el)) return null;
      const found = el.closest(selector);
      return (found && editable.contains(found)) ? found : null;
    }

    function setCaret(node, offset) {
      const sel = window.getSelection();
      if (!sel) return null;
      const r = document.createRange();
      r.setStart(node, offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
      return r;
    }

    function setCaretBefore(elNode) {
      const r = document.createRange();
      r.setStartBefore(elNode);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
      return r;
    }

    function setCaretAfter(elNode) {
      const r = document.createRange();
      r.setStartAfter(elNode);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      savedRange = r.cloneRange();
      return r;
    }

    function mergeAdjacentRevisions() {
      // Clean empty revision tags first
      editable.querySelectorAll('ins.rev-ins, del.rev-del').forEach(function (elNode) {
        if (!elNode.textContent && !elNode.querySelector('img, table, br')) {
          elNode.remove();
        }
      });
    }

    /**
     * Marks any selected Range as deleted:
     * - Text inside <ins class="rev-ins"> (lecturer's own addition) is removed cleanly
     * - Text already inside <del class="rev-del"> stays deleted
     * - Student original text is wrapped in <del class="rev-del">
     * Returns a collapsed Range positioned either 'before' or 'after' the deletion.
     */
    function markRangeDeleted(range, caretPlacement) {
      if (range.collapsed) return range;

      const textSlices = [];
      const walker = document.createTreeWalker(
        editable,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        }
      );

      let current;
      while ((current = walker.nextNode())) {
        let s = (current === range.startContainer) ? range.startOffset : 0;
        let e = (current === range.endContainer) ? range.endOffset : current.nodeValue.length;
        if (e > s) {
          textSlices.push({ node: current, start: s, end: e });
        }
      }

      let firstAffected = null;
      let lastAffected = null;

      textSlices.forEach(function (slice) {
        let targetNode = slice.node;
        if (slice.end < targetNode.nodeValue.length) {
          targetNode.splitText(slice.end);
        }
        if (slice.start > 0) {
          targetNode = targetNode.splitText(slice.start);
        }

        const parentIns = closestRev(targetNode, 'ins.rev-ins');
        const parentDel = closestRev(targetNode, 'del.rev-del');

        if (parentDel) {
          if (!firstAffected) firstAffected = parentDel;
          lastAffected = parentDel;
        } else if (parentIns) {
          const prev = targetNode.previousSibling || parentIns.previousSibling;
          targetNode.remove();
          if (!parentIns.textContent) {
            parentIns.remove();
          } else {
            if (!firstAffected) firstAffected = parentIns;
            lastAffected = parentIns;
          }
          if (!lastAffected && prev) lastAffected = prev;
        } else {
          const delEl = document.createElement('del');
          delEl.className = 'rev-del';
          delEl.setAttribute('data-rev-id', nextRevId());
          targetNode.parentNode.insertBefore(delEl, targetNode);
          delEl.appendChild(targetNode);
          if (!firstAffected) firstAffected = delEl;
          lastAffected = delEl;
        }
      });

      if (caretPlacement === 'before' && firstAffected && firstAffected.parentNode) {
        return setCaretBefore(firstAffected);
      }
      if (lastAffected && lastAffected.parentNode) {
        return setCaretAfter(lastAffected);
      }
      range.collapse(true);
      return range;
    }

    /**
     * Inserts new text at collapsed `range` wrapped inside <ins class="rev-ins">,
     * merging smoothly into an active or adjacent <ins> tag so continuous typing stays one tag.
     */
    function insertTrackedText(range, text) {
      if (!text) return;

      // 1. Caret is already inside <ins class="rev-ins">
      const activeIns = closestRev(range.startContainer, 'ins.rev-ins');
      if (activeIns && !closestRev(range.startContainer, 'del.rev-del')) {
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          const tNode = range.startContainer;
          const off = range.startOffset;
          tNode.insertData(off, text);
          setCaret(tNode, off + text.length);
          return;
        }
      }

      // 2. Caret is inside <del>: jump cleanly outside after <del> before inserting
      const activeDel = closestRev(range.startContainer, 'del.rev-del');
      if (activeDel) {
        range = setCaretAfter(activeDel);
      }

      // 3. Check if immediately preceded by an <ins class="rev-ins">
      let prevNode = null;
      if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
        prevNode = range.startContainer.previousSibling;
      } else if (range.startContainer.nodeType === Node.ELEMENT_NODE && range.startOffset > 0) {
        prevNode = range.startContainer.childNodes[range.startOffset - 1];
      }

      if (prevNode && prevNode.nodeType === 1 && prevNode.matches('ins.rev-ins')) {
        const lastChild = prevNode.lastChild;
        if (lastChild && lastChild.nodeType === Node.TEXT_NODE) {
          const len = lastChild.nodeValue.length;
          lastChild.appendData(text);
          setCaret(lastChild, len + text.length);
          return;
        }
      }

      // 4. Create a fresh <ins class="rev-ins">
      const ins = document.createElement('ins');
      ins.className = 'rev-ins';
      ins.setAttribute('data-rev-id', nextRevId());
      const txt = document.createTextNode(text);
      ins.appendChild(txt);
      range.insertNode(ins);
      setCaret(txt, text.length);
    }

    function findPreviousTextPosition(root, container, offset) {
      if (container.nodeType === Node.TEXT_NODE && offset > 0) {
        return { node: container, index: offset - 1 };
      }
      // Locate current boundary and walk backwards using TreeWalker
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let anchorText = null;
      if (container.nodeType === Node.TEXT_NODE) {
        anchorText = container;
      } else {
        // Element node: inspect child before offset
        if (offset > 0) {
          let child = container.childNodes[offset - 1];
          while (child && child.lastChild) child = child.lastChild;
          if (child && child.nodeType === Node.TEXT_NODE && child.nodeValue.length > 0) {
            return { node: child, index: child.nodeValue.length - 1 };
          }
        }
      }

      let prev = null;
      let curr;
      while ((curr = walker.nextNode())) {
        if (curr === anchorText) break;
        if (container.nodeType === Node.ELEMENT_NODE && offset === 0 && container.contains(curr)) {
          break;
        }
        if (curr.nodeValue.length > 0) prev = curr;
      }
      return prev ? { node: prev, index: prev.nodeValue.length - 1 } : null;
    }

    function findNextTextPosition(root, container, offset) {
      if (container.nodeType === Node.TEXT_NODE && offset < container.nodeValue.length) {
        return { node: container, index: offset };
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let passed = false;
      let curr;
      while ((curr = walker.nextNode())) {
        if (!passed) {
          if (curr === container) {
            passed = true;
            continue;
          }
          if (container.nodeType === Node.ELEMENT_NODE) {
            const targetChild = container.childNodes[offset];
            if (targetChild && (curr === targetChild || targetChild.contains(curr))) {
              if (curr.nodeValue.length > 0) return { node: curr, index: 0 };
              passed = true;
            }
          }
        } else if (curr.nodeValue.length > 0) {
          return { node: curr, index: 0 };
        }
      }
      return null;
    }

    function handleTrackedBackspace(range) {
      if (!range.collapsed) {
        markRangeDeleted(range, 'before');
        return;
      }

      // If caret is inside a <del>, step cleanly to the start of that <del>
      const insideDel = closestRev(range.startContainer, 'del.rev-del');
      if (insideDel) {
        range = setCaretBefore(insideDel);
      }

      let pos = findPreviousTextPosition(editable, range.startContainer, range.startOffset);
      // Skip backwards over any already-deleted <del> blocks so Backspace reaches live text
      while (pos && closestRev(pos.node, 'del.rev-del')) {
        const delBlock = closestRev(pos.node, 'del.rev-del');
        setCaretBefore(delBlock);
        pos = findPreviousTextPosition(editable, delBlock.parentNode, Array.prototype.indexOf.call(delBlock.parentNode.childNodes, delBlock));
      }

      if (!pos) return;

      const parentIns = closestRev(pos.node, 'ins.rev-ins');
      if (parentIns) {
        // Deleting lecturer's own inserted character removes it directly
        pos.node.deleteData(pos.index, 1);
        if (!parentIns.textContent) {
          const r = setCaretBefore(parentIns);
          parentIns.remove();
          return r;
        }
        setCaret(pos.node, pos.index);
        return;
      }

      // Student original character: extract 1 char and wrap/prepend into <del class="rev-del">
      const ch = pos.node.nodeValue.charAt(pos.index);
      const afterSplit = pos.node.splitText(pos.index);
      afterSplit.deleteData(0, 1);

      // Check if an existing <del> immediately follows so backspacing a word forms a single <del>
      let nextSib = afterSplit.nodeValue.length === 0 ? afterSplit.nextSibling : null;
      if (afterSplit.nodeValue.length === 0) afterSplit.remove();

      if (nextSib && nextSib.nodeType === 1 && nextSib.matches('del.rev-del') && nextSib.firstChild && nextSib.firstChild.nodeType === Node.TEXT_NODE) {
        nextSib.firstChild.insertData(0, ch);
        setCaretBefore(nextSib);
      } else {
        const del = document.createElement('del');
        del.className = 'rev-del';
        del.setAttribute('data-rev-id', nextRevId());
        del.textContent = ch;
        if (pos.node.nextSibling) {
          pos.node.parentNode.insertBefore(del, pos.node.nextSibling);
        } else {
          pos.node.parentNode.appendChild(del);
        }
        setCaretBefore(del);
      }
    }

    function handleTrackedDeleteForward(range) {
      if (!range.collapsed) {
        markRangeDeleted(range, 'after');
        return;
      }

      const insideDel = closestRev(range.startContainer, 'del.rev-del');
      if (insideDel) {
        range = setCaretAfter(insideDel);
      }

      let pos = findNextTextPosition(editable, range.startContainer, range.startOffset);
      while (pos && closestRev(pos.node, 'del.rev-del')) {
        const delBlock = closestRev(pos.node, 'del.rev-del');
        setCaretAfter(delBlock);
        pos = findNextTextPosition(editable, delBlock.parentNode, Array.prototype.indexOf.call(delBlock.parentNode.childNodes, delBlock) + 1);
      }

      if (!pos) return;

      const parentIns = closestRev(pos.node, 'ins.rev-ins');
      if (parentIns) {
        pos.node.deleteData(pos.index, 1);
        if (!parentIns.textContent) {
          setCaretBefore(parentIns);
          parentIns.remove();
          return;
        }
        setCaret(pos.node, pos.index);
        return;
      }

      const ch = pos.node.nodeValue.charAt(pos.index);
      const targetPart = pos.index > 0 ? pos.node.splitText(pos.index) : pos.node;
      targetPart.deleteData(0, 1);

      const prevSib = targetPart.previousSibling;
      if (prevSib && prevSib.nodeType === 1 && prevSib.matches('del.rev-del') && prevSib.lastChild && prevSib.lastChild.nodeType === Node.TEXT_NODE) {
        prevSib.lastChild.appendData(ch);
        if (!targetPart.nodeValue) targetPart.remove();
        setCaretAfter(prevSib);
      } else {
        const del = document.createElement('del');
        del.className = 'rev-del';
        del.setAttribute('data-rev-id', nextRevId());
        del.textContent = ch;
        targetPart.parentNode.insertBefore(del, targetPart);
        if (!targetPart.nodeValue) targetPart.remove();
        setCaretAfter(del);
      }
    }

    // Intercept typing, deletion, and replacement when Track Changes is ON
    editable.addEventListener('beforeinput', function (e) {
      if (!trackChanges) return;
      const ctx = selectionInside(editable);
      if (!ctx) return;

      const type = e.inputType;

      if (type === 'insertText' || type === 'insertReplacementText') {
        e.preventDefault();
        let r = ctx.range;
        if (!r.collapsed) {
          r = markRangeDeleted(r, 'after');
        }
        if (e.data) {
          insertTrackedText(r, e.data);
        }
        commitEdit(false);
      } else if (type === 'deleteContentBackward') {
        e.preventDefault();
        handleTrackedBackspace(ctx.range);
        commitEdit(false);
      } else if (type === 'deleteContentForward') {
        e.preventDefault();
        handleTrackedDeleteForward(ctx.range);
        commitEdit(false);
      } else if (type === 'deleteWordBackward' || type === 'deleteWordForward') {
        e.preventDefault();
        if (ctx.range.collapsed && ctx.sel.modify) {
          ctx.sel.modify('extend', type === 'deleteWordBackward' ? 'backward' : 'forward', 'word');
        }
        const extCtx = selectionInside(editable);
        if (extCtx && !extCtx.range.collapsed) {
          markRangeDeleted(extCtx.range, type === 'deleteWordBackward' ? 'before' : 'after');
          commitEdit(true);
        }
      } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
        if (!ctx.range.collapsed) {
          markRangeDeleted(ctx.range, 'after');
        }
        // Step out of active <ins> at boundary so new paragraph starts cleanly
        const activeIns = closestRev(ctx.range.startContainer, 'ins.rev-ins');
        if (activeIns && ctx.range.startContainer.nodeType === Node.TEXT_NODE && ctx.range.startOffset === ctx.range.startContainer.nodeValue.length) {
          setCaretAfter(activeIns);
        }
      } else if (type === 'historyUndo') {
        e.preventDefault();
        undo();
      } else if (type === 'historyRedo') {
        e.preventDefault();
        redo();
      }
    });

    // Keyboard shortcuts (Undo/Redo & Escape to step outside an insertion)
    editable.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
          return;
        }
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          e.preventDefault();
          redo();
          return;
        }
      }
      if (e.key === 'Escape') {
        const ctx = selectionInside(editable);
        if (!ctx) return;
        const insEl = closestRev(ctx.range.startContainer, 'ins.rev-ins');
        if (insEl) {
          e.preventDefault();
          setCaretAfter(insEl);
        }
      }
    });

    // Tracked Cut & Paste
    editable.addEventListener('cut', function (e) {
      const ctx = selectionInside(editable);
      if (!ctx || ctx.range.collapsed) return;
      if (trackChanges) {
        e.preventDefault();
        e.clipboardData.setData('text/plain', ctx.range.toString());
        markRangeDeleted(ctx.range, 'after');
        commitEdit(true);
      }
    });

    editable.addEventListener('paste', function (e) {
      e.preventDefault();
      const ctx = selectionInside(editable);
      if (!ctx) return;

      const textData = e.clipboardData.getData('text/plain');
      const htmlData = e.clipboardData.getData('text/html');

      if (trackChanges) {
        let r = ctx.range;
        if (!r.collapsed) {
          r = markRangeDeleted(r, 'after');
        }
        if (textData) {
          insertTrackedText(r, textData.replace(/\r?\n+/g, ' '));
        }
        commitEdit(true);
      } else {
        if (htmlData) {
          document.execCommand('insertHTML', false, sanitiseHtml(htmlData));
        } else if (textData) {
          document.execCommand('insertText', false, textData);
        }
        commitEdit(true);
      }
    });

    editable.addEventListener('input', function () {
      commitEdit(false);
    });

    function captureSelection() {
      const ctx = selectionInside(editable);
      if (ctx) {
        savedRange = ctx.range.cloneRange();
      }
    }
    editable.addEventListener('mouseup', captureSelection);
    editable.addEventListener('keyup', captureSelection);

    editable.addEventListener('click', function (e) {
      const anchor = e.target.closest('span.rev-anchor');
      if (anchor) {
        onClickAnchor(anchor.getAttribute('data-comment-id'));
      }
      const clickedRev = e.target.closest('ins.rev-ins, del.rev-del');
      if (clickedRev && editable.contains(clickedRev)) {
        const list = getAllRevisions();
        const idx = list.indexOf(clickedRev);
        if (idx !== -1) focusRevisionByIndex(idx, false);
      }
    });

    // =========================================================
    // REVISION NAVIGATION & ACCEPT / REJECT CONTROLS
    // =========================================================
    function getAllRevisions() {
      return Array.from(editable.querySelectorAll('ins.rev-ins, del.rev-del'));
    }

    function clearFocusClasses() {
      editable.querySelectorAll('.rev-focused').forEach(function (elNode) {
        elNode.classList.remove('rev-focused');
      });
    }

    function focusRevisionByIndex(index, scroll) {
      const revs = getAllRevisions();
      clearFocusClasses();
      if (revs.length === 0) {
        focusedRevIndex = -1;
        return null;
      }
      focusedRevIndex = ((index % revs.length) + revs.length) % revs.length;
      const target = revs[focusedRevIndex];
      target.classList.add('rev-focused');
      if (scroll !== false) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return target;
    }

    function getTargetRevision() {
      const revs = getAllRevisions();
      if (revs.length === 0) return null;
      const ctx = selectionInside(editable) || (savedRange ? { range: savedRange } : null);
      if (ctx) {
        const direct = closestRev(ctx.range.commonAncestorContainer, 'ins.rev-ins, del.rev-del');
        if (direct) return direct;
      }
      if (focusedRevIndex >= 0 && focusedRevIndex < revs.length) {
        return revs[focusedRevIndex];
      }
      return revs[0];
    }

    function acceptSingleRevision(revEl) {
      if (!revEl) return;
      if (revEl.matches('ins.rev-ins')) {
        unwrapElement(revEl);
      } else if (revEl.matches('del.rev-del')) {
        revEl.remove();
      }
    }

    function rejectSingleRevision(revEl) {
      if (!revEl) return;
      if (revEl.matches('ins.rev-ins')) {
        revEl.remove();
      } else if (revEl.matches('del.rev-del')) {
        unwrapElement(revEl);
      }
    }

    // =========================================================
    // RIBBON EVENT HANDLERS
    // =========================================================
    editToolbar.addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      const cmd = btn.getAttribute('data-cmd');
      const editAct = btn.getAttribute('data-edit');

      if (cmd) {
        editable.focus();
        document.execCommand(cmd, false, null);
        commitEdit(true);
      } else if (editAct === 'undo') {
        undo();
      } else if (editAct === 'redo') {
        redo();
      } else if (editAct === 'table') {
        editable.focus();
        document.execCommand('insertHTML', false, buildTableHtml(3, 3));
        commitEdit(true);
      } else if (editAct === 'symbols') {
        symBar.classList.toggle('hidden');
      }
    });

    editToolbar.addEventListener('change', function (e) {
      const sel = e.target;
      if (sel.getAttribute('data-action') === 'block' && sel.value) {
        editable.focus();
        document.execCommand('formatBlock', false, sel.value);
        commitEdit(true);
      }
    });

    reviewToolbar.addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      const revAct = btn.getAttribute('data-rev');

      if (revAct === 'toggle-track') {
        trackChanges = !trackChanges;
        trackBtn.classList.toggle('active', trackChanges);
        trackLabel.textContent = 'Track Changes: ' + (trackChanges ? 'ON' : 'OFF');
      } else if (revAct === 'prev') {
        focusRevisionByIndex(focusedRevIndex <= 0 ? getAllRevisions().length - 1 : focusedRevIndex - 1, true);
      } else if (revAct === 'next') {
        focusRevisionByIndex(focusedRevIndex + 1, true);
      } else if (revAct === 'accept') {
        const target = getTargetRevision();
        if (target) {
          acceptSingleRevision(target);
          commitEdit(true);
          focusRevisionByIndex(focusedRevIndex, true);
        }
      } else if (revAct === 'reject') {
        const target = getTargetRevision();
        if (target) {
          rejectSingleRevision(target);
          commitEdit(true);
          focusRevisionByIndex(focusedRevIndex, true);
        }
      } else if (revAct === 'accept-all') {
        const revs = getAllRevisions();
        if (revs.length === 0) return;
        revs.forEach(acceptSingleRevision);
        clearFocusClasses();
        commitEdit(true);
      } else if (revAct === 'reject-all') {
        const revs = getAllRevisions();
        if (revs.length === 0) return;
        revs.forEach(rejectSingleRevision);
        clearFocusClasses();
        commitEdit(true);
      } else if (revAct === 'comment') {
        const ctx = selectionInside(editable) || (savedRange ? { range: savedRange } : null);
        if (!ctx || ctx.range.collapsed) return;
        savedRange = ctx.range.cloneRange();
        onRequestComment(ctx.range.toString());
      }
    });

    reviewToolbar.addEventListener('change', function (e) {
      const sel = e.target;
      const revAct = sel.getAttribute('data-rev');

      if (revAct === 'view-mode') {
        setViewMode(sel.value);
        onViewModeChange(viewMode);
      } else if (revAct === 'highlight' && sel.value) {
        const ctx = selectionInside(editable) || (savedRange ? { range: savedRange } : null);
        if (ctx) {
          if (sel.value === '__CLEAR__') {
            const hl = closestRev(ctx.range.commonAncestorContainer, 'mark.rev-hl');
            if (hl) {
              unwrapElement(hl);
              commitEdit(true);
            }
          } else if (!ctx.range.collapsed) {
            const mark = document.createElement('mark');
            mark.className = 'rev-hl';
            mark.setAttribute('data-tag', sel.value);
            mark.appendChild(ctx.range.extractContents());
            ctx.range.insertNode(mark);
            commitEdit(true);
          }
        }
        sel.value = '';
      }
    });

    function setViewMode(mode) {
      viewMode = mode || 'all-markup';
      viewSelect.value = viewMode;
      editable.classList.remove('view-all-markup', 'view-simple-markup', 'view-no-markup', 'view-original');
      editable.classList.add('view-' + viewMode);
    }

    function attachCommentAnchor(commentId) {
      if (!savedRange || savedRange.collapsed) return false;
      const span = document.createElement('span');
      span.className = 'rev-anchor';
      span.setAttribute('data-comment-id', commentId);
      span.appendChild(savedRange.extractContents());
      savedRange.insertNode(span);
      savedRange = null;
      commitEdit(true);
      return true;
    }

    function removeCommentAnchor(commentId) {
      const anchors = editable.querySelectorAll('span.rev-anchor[data-comment-id="' + commentId + '"]');
      anchors.forEach(unwrapElement);
      commitEdit(true);
    }

    function getRevisionStats() {
      return {
        insertions: editable.querySelectorAll('ins.rev-ins').length,
        deletions: editable.querySelectorAll('del.rev-del').length
      };
    }

    function getHtml() {
      return sanitiseHtml(editable.innerHTML.replace(/\u200B/g, ''));
    }

    function setHtml(html) {
      clearFocusClasses();
      focusedRevIndex = -1;
      editable.innerHTML = sanitiseHtml(html || '<p><br></p>');
      historyStack = [sanitiseHtml(editable.innerHTML)];
      historyIdx = 0;
    }

    return {
      getHtml: getHtml,
      setHtml: setHtml,
      getViewMode: function () { return viewMode; },
      setViewMode: setViewMode,
      getRevisionStats: getRevisionStats,
      attachCommentAnchor: attachCommentAnchor,
      removeCommentAnchor: removeCommentAnchor,
      getRootElement: function () { return editable; }
    };
  }

  global.HubEditor = {
    sanitiseHtml: sanitiseHtml,
    countWordsFromHtml: countWordsFromHtml,
    initStudentEditor: initStudentEditor,
    initAdminEditor: initAdminEditor
  };
})(window);