/*
 * SSG 영수증 PDF 파서
 * PDF.js의 getTextContent() 좌표(transform)를 이용해
 * 판매자 / 제품명 / 수량 / 구매금액 열을 x좌표로 구분하고,
 * 상품 단위로 텍스트를 재조합한다.
 */

const SsgReceiptParser = (function () {

  // x좌표 기준 열 경계값 (영수증.pdf 실측 좌표 기반)
  const COL = {
    SELLER_MIN: 85,
    PRODUCT_MIN: 185,
    QTY_MIN: 445,
    AMOUNT_MIN: 500
  };

  // 페이지마다 반복되는 헤더/로고 텍스트 (그대로 일치할 때만 제외)
  const NOISE_EXACT = new Set([
    '면세', '판매자', '제품명', '수량', '구매금액', '구매내역', 'SSG',
    '상품명 앞(*)는 면세상품입니다.'
  ]);

  // 이 문구가 나오면 상품 추출을 종료한다 (구매내역 이후 요약/결제 영역)
  const STOP_KEYWORDS = [
    '구매내역합계', '내역합계', '면세품가액', '과세물품가액',
    '구매합계', '기타비용', '결제내역', '승인일시', '결제수단'
  ];

  function classifyColumn(x) {
    if (x >= COL.AMOUNT_MIN) return 'amount';
    if (x >= COL.QTY_MIN) return 'qty';
    if (x >= COL.PRODUCT_MIN) return 'product';
    if (x >= COL.SELLER_MIN) return 'seller';
    return 'mark';
  }

  function isNoiseText(text) {
    const t = text.trim();
    if (t === '') return true;
    if (NOISE_EXACT.has(t)) return true;
    return false;
  }

  function isStopText(text) {
    const t = text.trim();
    if (!t) return false;
    return STOP_KEYWORDS.some(function (kw) { return t.includes(kw); });
  }

  // '주문번호' 값(예: "2026-08-05-1C5547", 년-월-일-주문번호)에서 월.일만 뽑아 "08.05" 형식으로 변환
  function extractOrderDate(items) {
    for (let i = 0; i < items.length; i++) {
      const m = items[i].text.trim().match(/^\d{4}-(\d{2})-(\d{2})-\w+$/);
      if (m) return m[1] + '.' + m[2];
    }
    return '';
  }

  // PDF 한 페이지의 items를 {text, x, y, col} 형태로 변환
  function toPositionedItems(textContent) {
    return textContent.items
      .filter(function (item) { return item.str.trim() !== ''; })
      .map(function (item) {
        const x = item.transform[4];
        const y = item.transform[5];
        return { text: item.str, x: x, y: y, col: classifyColumn(x) };
      });
  }

  // 제품명 열의 아이템들을 y좌표로 줄 단위로 묶고, "옵션" 줄은 제외한 뒤 한 줄로 합친다
  function buildProductName(nameItems) {
    if (nameItems.length === 0) return '';

    const lines = [];
    let currentY = null;
    let currentLine = '';

    nameItems.forEach(function (item) {
      if (currentY === null || Math.abs(item.y - currentY) > 0.5) {
        if (currentLine !== '') lines.push(currentLine);
        currentLine = item.text;
        currentY = item.y;
      } else {
        currentLine += item.text;
      }
    });
    if (currentLine !== '') lines.push(currentLine);

    const filtered = lines
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line !== '' && !line.startsWith('옵션'); });

    return filtered.join(' ').replace(/\s+/g, ' ').trim();
  }

  // 문자열 전체가 아이템들의 흐름(seller -> product(옵션 포함) -> qty -> amount)을
  // 순서대로 훑으면서 상품 단위로 조립한다.
  function extractProductsFromItems(items) {
    const products = [];
    let nameBuffer = [];
    let qtyDigits = '';
    let amountDigits = '';
    let qtyValue = null;
    let stopped = false;
    let started = false; // '제품명' 열 헤더를 만나기 전까지는 주문번호/발급일시 등 상단 정보를 모두 무시

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!started) {
        if (item.text.trim() === '제품명') started = true;
        continue;
      }

      if (isStopText(item.text)) {
        stopped = true;
        break;
      }

      if (isNoiseText(item.text)) continue;

      switch (item.col) {
        case 'mark':
        case 'seller':
          // 판매자/면세 표시 열은 상품명에서 제외
          break;

        case 'product':
          nameBuffer.push(item);
          break;

        case 'qty': {
          const t = item.text.trim();
          if (/^\d+$/.test(t)) {
            qtyDigits += t;
          } else if (t === '개') {
            qtyValue = parseInt(qtyDigits, 10);
            qtyDigits = '';
          }
          break;
        }

        case 'amount': {
          const t = item.text.trim();
          if (/^[\d,]+$/.test(t)) {
            amountDigits += t.replace(/,/g, '');
          } else if (t === '원') {
            const amountValue = parseInt(amountDigits, 10);
            amountDigits = '';

            // 수량 + 구매금액이 함께 확정되는 지점 = 상품 한 건의 끝
            const name = buildProductName(nameBuffer);
            if (name && qtyValue !== null && !isNaN(amountValue)) {
              products.push({ name: name, qty: qtyValue, amount: amountValue });
            }
            nameBuffer = [];
            qtyValue = null;
          }
          break;
        }
      }
    }

    return { products: products, stopped: stopped };
  }

  /**
   * PDF 파일(ArrayBuffer)을 받아 상품 목록을 반환한다.
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<Array<{date:string, name:string, qty:number, amount:number}>>}
   */
  async function parseReceiptPdf(arrayBuffer) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF.js 라이브러리를 불러오지 못했습니다.');
    }

    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    let allItems = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      allItems = allItems.concat(toPositionedItems(textContent));
    }

    const result = extractProductsFromItems(allItems);

    if (result.products.length === 0) {
      throw new Error('구매내역에서 상품 정보를 찾을 수 없습니다. SSG 영수증 PDF가 맞는지 확인해주세요.');
    }

    const orderDate = extractOrderDate(allItems);

    return result.products.map(function (product) {
      return Object.assign({ date: orderDate }, product);
    });
  }

  return {
    parseReceiptPdf: parseReceiptPdf
  };
})();
