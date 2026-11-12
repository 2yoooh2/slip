/*
 * 화면 UI 처리
 * - PDF 업로드(선택/드래그앤드롭/추가), 파일별 칩 표시·제거
 * - 파싱 결과 테이블 렌더링 및 수정, 요약·합계 계산
 * - 행 삭제/복사, 전체 복사, 초기화
 *
 * 주의: 추출 로직(parser.js)과 엑셀 복사 형식(toRowText)은 화면 개편과 무관하게 유지한다.
 */

(function () {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/lib/pdf.worker.min.js';

  const fileInput = document.getElementById('fileInput');
  const fileSelectBtn = document.getElementById('fileSelectBtn');
  const dropZone = document.getElementById('dropZone');
  const dropZoneStatus = document.getElementById('dropZoneStatus');
  const uploadSection = document.getElementById('uploadSection');

  const fileBar = document.getElementById('fileBar');
  const fileChips = document.getElementById('fileChips');
  const addFileBtn = document.getElementById('addFileBtn');

  const resultSection = document.getElementById('resultSection');
  const resultTbody = document.getElementById('resultTbody');
  const itemCountEl = document.getElementById('itemCount');
  const statQtyEl = document.getElementById('statQty');
  const statAmountEl = document.getElementById('statAmount');
  const totalQtyEl = document.getElementById('totalQty');
  const totalAmountEl = document.getElementById('totalAmount');
  const copyAllBtn = document.getElementById('copyAllBtn');
  const resetBtn = document.getElementById('resetBtn');

  const errorBanner = document.getElementById('errorBanner');
  const errorBannerText = document.getElementById('errorBannerText');
  const toast = document.getElementById('toast');

  let items = [];  // { date, name, qty, amount, fileId }
  let files = [];  // { id, name, key }
  const pendingKeys = new Set(); // 처리 중인 파일 (동시에 같은 파일을 올리는 경우 대비)
  let nextFileId = 1;
  let busyCount = 0;
  let toastTimer = null;
  let toastClearTimer = null;

  // ===== 아이콘 (정적 SVG 문자열) =====

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>'
  };

  // ===== 유틸 =====

  function showError(message) {
    errorBannerText.textContent = message;
    errorBanner.hidden = false;
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBannerText.textContent = '';
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    clearTimeout(toastClearTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
      // 같은 문구가 다시 와도 스크린리더가 읽도록 숨김 후 비워둔다
      toastClearTimer = setTimeout(function () { toast.textContent = ''; }, 250);
    }, 2400);
  }

  function copiedMessage(count) {
    return count + '개 항목을 복사했어요 · B열 시작 셀에 붙여넣기';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 클립보드 API 사용 불가 시 폴백
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(textarea);
      return ok;
    }
  }

  // 화면 표시용 금액 포맷 (숫자만 있는 값에 천 단위 쉼표). 저장값/복사값에는 사용하지 않음
  function formatAmount(value) {
    const str = String(value);
    return /^-?\d+$/.test(str) ? str.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : str;
  }

  // 화면 합계 계산용 숫자 변환 (사용자가 쉼표를 넣어 수정한 경우도 허용)
  function toNumber(value) {
    const n = Number(String(value).replace(/,/g, '').trim());
    return isFinite(n) ? n : 0;
  }

  // 주문일자 \t 제품명 \t \t 구매금액 \t \t 수량
  function toRowText(item) {
    return [item.date, item.name, '', item.amount, '', item.qty].join('\t');
  }

  // ===== 렌더링 =====

  function render() {
    resultTbody.textContent = '';

    if (items.length === 0) {
      const tr = document.createElement('tr');
      tr.className = 'row-empty';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = '표시할 항목이 없어요. PDF를 추가하거나 초기화해 주세요.';
      tr.appendChild(td);
      resultTbody.appendChild(tr);
    }

    items.forEach(function (item, index) {
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);

      tr.appendChild(buildEditableCell('date', item.date, 'cell-date num', '주문일자'));
      tr.appendChild(buildEditableCell('name', item.name, 'cell-name', '제품명'));
      tr.appendChild(buildEditableCell('qty', item.qty, 'cell-qty num', '수량'));
      tr.appendChild(buildEditableCell('amount', formatAmount(item.amount), 'cell-amount num', '구매금액'));

      const actionTd = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(buildIconButton('copy', ICON.copy, item.name + ' 복사'));
      actions.appendChild(buildIconButton('delete', ICON.trash, item.name + ' 삭제'));
      actionTd.appendChild(actions);
      tr.appendChild(actionTd);

      resultTbody.appendChild(tr);
    });

    renderSummary();
    renderFileChips();
    updateView();
  }

  function buildEditableCell(field, displayValue, cellClass, label) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-editable ' + cellClass;
    input.dataset.field = field;
    input.value = String(displayValue);
    input.setAttribute('aria-label', label);
    if (field === 'name') input.title = String(displayValue);
    td.appendChild(input);
    return td;
  }

  function buildIconButton(action, icon, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn' + (action === 'delete' ? ' is-delete' : '');
    btn.dataset.action = action;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon; // 정적 아이콘만 innerHTML 사용 (데이터는 넣지 않음)
    return btn;
  }

  function renderSummary() {
    const qty = items.reduce(function (sum, i) { return sum + toNumber(i.qty); }, 0);
    const amount = items.reduce(function (sum, i) { return sum + toNumber(i.amount); }, 0);
    itemCountEl.textContent = items.length.toLocaleString('ko-KR');
    statQtyEl.textContent = totalQtyEl.textContent = qty.toLocaleString('ko-KR');
    statAmountEl.textContent = totalAmountEl.textContent = amount.toLocaleString('ko-KR');
    copyAllBtn.disabled = items.length === 0;
  }

  function renderFileChips() {
    fileChips.textContent = '';
    files.forEach(function (file) {
      const count = items.filter(function (i) { return i.fileId === file.id; }).length;

      const li = document.createElement('li');
      li.className = 'file-chip';

      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.innerHTML = ICON.pdf;

      const name = document.createElement('span');
      name.className = 'file-chip-name';
      name.textContent = file.name;
      name.title = file.name;

      const meta = document.createElement('span');
      meta.className = 'file-chip-count num';
      meta.textContent = count + '개 항목';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn icon-btn-sm';
      remove.dataset.fileId = String(file.id);
      remove.setAttribute('aria-label', file.name + ' 제거');
      remove.innerHTML = ICON.close;

      li.appendChild(icon);
      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(remove);
      fileChips.appendChild(li);
    });
  }

  function updateView() {
    const hasFiles = files.length > 0;
    uploadSection.hidden = hasFiles;
    fileBar.hidden = !hasFiles;
    resultSection.hidden = !hasFiles;
    dropZoneStatus.textContent = busyCount > 0 ? 'PDF를 읽는 중이에요…' : '';
    dropZone.classList.toggle('is-busy', busyCount > 0);
    addFileBtn.disabled = busyCount > 0;
  }

  // ===== PDF 처리 =====

  async function handleFiles(fileList) {
    clearError();

    const selected = Array.from(fileList || []);
    if (selected.length === 0) return;

    const invalidFile = selected.find(function (f) {
      return f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf');
    });
    if (invalidFile) {
      showError('PDF 파일만 업로드할 수 있습니다.');
      return;
    }

    // 중복 파일 제외: 이미 업로드했거나, 처리 중이거나, 이번 선택 안에서 겹치는 파일
    const toProcess = [];
    const skipped = [];
    selected.forEach(function (file) {
      const key = fileKey(file);
      const isDup = pendingKeys.has(key) || files.some(function (f) { return f.key === key; });
      if (isDup) {
        skipped.push(file.name);
      } else {
        pendingKeys.add(key);
        toProcess.push({ file: file, key: key });
      }
    });

    if (skipped.length > 0) {
      showToast('이미 올린 파일은 건너뛰었어요 · ' + skipped.join(', '));
    }
    if (toProcess.length === 0) return;

    busyCount++;
    updateView();

    const errors = [];
    for (const entry of toProcess) {
      const file = entry.file;
      try {
        const arrayBuffer = await file.arrayBuffer();
        const parsed = await SsgReceiptParser.parseReceiptPdf(arrayBuffer);
        const fileId = nextFileId++;
        files.push({ id: fileId, name: file.name, key: entry.key });
        parsed.forEach(function (item) { item.fileId = fileId; });
        items = items.concat(parsed);
      } catch (err) {
        console.error(err);
        errors.push(file.name + ': ' + (err && err.message ? err.message : 'PDF를 처리하는 중 오류가 발생했습니다.'));
      } finally {
        pendingKeys.delete(entry.key);
      }
    }

    busyCount--;
    render();
    if (errors.length > 0) {
      showError(errors.join(' / '));
    }
  }

  // 같은 파일 판별용 키 (이름 + 크기 + 수정 시각)
  function fileKey(file) {
    return [file.name, file.size, file.lastModified].join('|');
  }

  function removeFile(fileId) {
    files = files.filter(function (f) { return f.id !== fileId; });
    items = items.filter(function (i) { return i.fileId !== fileId; });
    if (files.length === 0) {
      resetAll();
      fileSelectBtn.focus();
    } else {
      render();
      addFileBtn.focus();
    }
  }

  function resetAll() {
    items = [];
    files = [];
    fileInput.value = '';
    clearError();
    render();
  }

  // ===== 이벤트 바인딩 =====

  function openFilePicker() {
    fileInput.click();
  }

  fileSelectBtn.addEventListener('click', openFilePicker);
  addFileBtn.addEventListener('click', openFilePicker);

  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
    fileInput.value = ''; // 같은 파일을 다시 추가할 수 있도록
  });

  // 드롭존(업로드 전)과 파일 바(업로드 후) 모두 드래그 앤 드롭 지원
  function bindDropTarget(el) {
    el.addEventListener('dragover', function (e) {
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', function (e) {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
    });
    el.addEventListener('drop', function (e) {
      e.preventDefault();
      el.classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });
  }
  bindDropTarget(dropZone);
  bindDropTarget(fileBar);

  // 드롭 대상 밖에 놓쳤을 때 브라우저가 PDF를 열어 결과가 사라지지 않도록
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  // 파일 칩 제거 (이벤트 위임)
  fileChips.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-file-id]');
    if (btn) removeFile(Number(btn.dataset.fileId));
  });

  // 행 복사/삭제 (이벤트 위임)
  resultTbody.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const index = Number(tr.dataset.index);

    if (btn.dataset.action === 'copy') {
      copyText(toRowText(items[index])).then(function (ok) {
        if (!ok) {
          showToast('복사에 실패했어요. 다시 시도해 주세요.');
          return;
        }
        showToast(copiedMessage(1));
        btn.innerHTML = ICON.check;
        btn.classList.add('is-copied');
        clearTimeout(btn._resetTimer);
        btn._resetTimer = setTimeout(function () {
          btn.innerHTML = ICON.copy;
          btn.classList.remove('is-copied');
        }, 1500);
      });
    } else if (btn.dataset.action === 'delete') {
      items.splice(index, 1);
      render();
      // 키보드 사용자를 위해 다음(또는 이전) 행의 삭제 버튼으로 포커스 이동
      const nextRow = resultTbody.rows[index] || resultTbody.rows[index - 1];
      const nextBtn = nextRow && nextRow.querySelector('button[data-action="delete"]');
      (nextBtn || addFileBtn).focus();
    }
  });

  // 셀 수정 (이벤트 위임)
  resultTbody.addEventListener('change', function (e) {
    const input = e.target;
    const field = input.dataset && input.dataset.field;
    if (!field) return;
    const index = Number(input.closest('tr').dataset.index);
    items[index][field] = input.value;
    if (field === 'name') input.title = input.value;
    if (field === 'qty' || field === 'amount') renderSummary();
  });

  // 구매금액: 화면에는 쉼표 표시, 편집 중(포커스)에는 원래 값 그대로 표시
  resultTbody.addEventListener('focusin', function (e) {
    const input = e.target;
    if (input.dataset && input.dataset.field === 'amount') {
      input.value = String(items[Number(input.closest('tr').dataset.index)].amount);
    }
  });
  resultTbody.addEventListener('focusout', function (e) {
    const input = e.target;
    if (input.dataset && input.dataset.field === 'amount') {
      const tr = input.closest('tr');
      if (tr && items[Number(tr.dataset.index)]) {
        input.value = formatAmount(items[Number(tr.dataset.index)].amount);
      }
    }
  });

  copyAllBtn.addEventListener('click', function () {
    if (items.length === 0) return;
    const text = items.map(toRowText).join('\n');
    copyText(text).then(function (ok) {
      showToast(ok ? copiedMessage(items.length) : '복사에 실패했어요. 다시 시도해 주세요.');
    });
  });

  // 로고·제목 클릭 → 홈(업로드 전 화면). 결과가 있으면 한 번 확인한다
  document.getElementById('homeLink').addEventListener('click', function (e) {
    e.preventDefault();
    if (files.length > 0 && !window.confirm('추출한 결과가 모두 지워져요. 처음 화면으로 돌아갈까요?')) {
      return;
    }
    resetAll();
    window.scrollTo(0, 0);
  });

  resetBtn.addEventListener('click', function () {
    resetAll();
    fileSelectBtn.focus();
  });

  // 초기 렌더링 (업로드 전 화면)
  render();
})();
