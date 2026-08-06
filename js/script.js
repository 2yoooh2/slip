/*
 * 화면 UI 처리
 * - PDF 업로드(선택/드래그앤드롭)
 * - 파싱 결과 테이블 렌더링 및 수정
 * - 행 삭제/복사, 전체 복사, 초기화
 */

(function () {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/lib/pdf.worker.min.js';

  const fileInput = document.getElementById('fileInput');
  const fileSelectBtn = document.getElementById('fileSelectBtn');
  const dropZone = document.getElementById('dropZone');
  const fileNameDisplay = document.getElementById('fileNameDisplay');

  const resultSection = document.getElementById('resultSection');
  const resultTbody = document.getElementById('resultTbody');
  const itemCountEl = document.getElementById('itemCount');
  const copyAllBtn = document.getElementById('copyAllBtn');
  const resetBtn = document.getElementById('resetBtn');

  const errorBanner = document.getElementById('errorBanner');
  const errorBannerText = document.getElementById('errorBannerText');
  const toast = document.getElementById('toast');

  let items = []; // { name, qty, amount }
  let toastTimer = null;

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
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 1800);
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

  // 주문일자 \t 제품명 \t \t 구매금액 \t \t 수량
  function toRowText(item) {
    return [item.date, item.name, '', item.amount, '', item.qty].join('\t');
  }

  // ===== 렌더링 =====

  function render() {
    resultTbody.innerHTML = '';

    items.forEach(function (item, index) {
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);

      tr.appendChild(buildEditableCell('date', item.date, 'cell-date'));
      tr.appendChild(buildEditableCell('name', item.name, 'cell-name'));
      tr.appendChild(buildEditableCell('amount', item.amount, 'cell-amount'));
      tr.appendChild(buildEditableCell('qty', item.qty, 'cell-qty'));

      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-outline btn-small';
      copyBtn.textContent = '복사';
      copyBtn.addEventListener('click', function () {
        copyText(toRowText(items[index])).then(function (ok) {
          showToast(ok ? '행이 복사되었습니다.' : '복사에 실패했습니다.');
        });
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-danger-outline btn-small';
      deleteBtn.textContent = '삭제';
      deleteBtn.addEventListener('click', function () {
        items.splice(index, 1);
        render();
      });

      actionTd.appendChild(copyBtn);
      actionTd.appendChild(deleteBtn);
      tr.appendChild(actionTd);

      resultTbody.appendChild(tr);
    });

    itemCountEl.textContent = String(items.length);
    resultSection.classList.toggle('has-data', items.length > 0);
  }

  function buildEditableCell(field, value, cellClass) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-editable ' + cellClass;
    input.value = String(value);
    input.addEventListener('change', function () {
      const index = Number(td.parentElement.dataset.index);
      if (field === 'date') {
        items[index].date = input.value;
      } else if (field === 'name') {
        items[index].name = input.value;
      } else if (field === 'amount') {
        items[index].amount = input.value;
      } else if (field === 'qty') {
        items[index].qty = input.value;
      }
    });
    td.appendChild(input);
    return td;
  }

  // ===== PDF 처리 =====

  async function handleFiles(fileList) {
    clearError();

    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const invalidFile = files.find(function (f) {
      return f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf');
    });
    if (invalidFile) {
      showError('PDF 파일만 업로드할 수 있습니다.');
      return;
    }

    fileNameDisplay.textContent = files.length === 1
      ? files[0].name
      : files.length + '개 파일: ' + files.map(function (f) { return f.name; }).join(', ');

    items = [];
    render();

    const errors = [];
    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const parsed = await SsgReceiptParser.parseReceiptPdf(arrayBuffer);
        items = items.concat(parsed);
      } catch (err) {
        console.error(err);
        errors.push(file.name + ': ' + (err && err.message ? err.message : 'PDF를 처리하는 중 오류가 발생했습니다.'));
      }
    }

    render();
    if (errors.length > 0) {
      showError(errors.join(' / '));
    }
  }

  function resetAll() {
    items = [];
    fileInput.value = '';
    fileNameDisplay.textContent = '';
    clearError();
    render();
  }

  // ===== 이벤트 바인딩 =====

  fileSelectBtn.addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    handleFiles(fileInput.files);
  });

  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  copyAllBtn.addEventListener('click', function () {
    if (items.length === 0) {
      showToast('복사할 상품이 없습니다.');
      return;
    }
    const text = items.map(toRowText).join('\n');
    copyText(text).then(function (ok) {
      showToast(ok ? '전체 상품이 복사되었습니다.' : '복사에 실패했습니다.');
    });
  });

  resetBtn.addEventListener('click', resetAll);

  // 초기 렌더링 (빈 상태)
  render();
})();
