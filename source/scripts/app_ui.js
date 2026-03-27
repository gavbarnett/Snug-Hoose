// App UI module: upload handling, input listeners, output rendering, and download link management.

export function initAppUi(opts) {
  const onSolveRequested = opts.onSolveRequested;
  const onUploadDemo = opts.onUploadDemo;

  const outEl = document.getElementById('out');
  const dlEl = document.getElementById('download');
  const indoorInput = document.getElementById('indoorTemp');
  const externalInput = document.getElementById('externalTemp');
  const flowTempInput = document.getElementById('flowTemp');
  const fileUpload = document.getElementById('fileUpload');
  const uploadBtn = document.getElementById('uploadBtn');

  let lastDownloadUrl = null;

  if (uploadBtn && fileUpload) {
    uploadBtn.addEventListener('click', () => {
      fileUpload.click();
    });

    fileUpload.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const uploadedDemo = JSON.parse(text);
        setStatus('Processing uploaded file...');
        if (typeof onUploadDemo === 'function') {
          onUploadDemo(uploadedDemo);
        }
      } catch (err) {
        setStatus('Error parsing JSON file: ' + String(err));
        console.error(err);
      }
    });
  }

  const triggerSolveFromInput = () => {
    if (typeof onSolveRequested === 'function') onSolveRequested();
  };

  if (indoorInput) indoorInput.addEventListener('change', triggerSolveFromInput);
  if (externalInput) externalInput.addEventListener('change', triggerSolveFromInput);
  if (flowTempInput) flowTempInput.addEventListener('change', triggerSolveFromInput);

  function getTemperatureInputs() {
    return {
      indoorTemp: parseFloat(indoorInput?.value),
      externalTemp: parseFloat(externalInput?.value),
      flowTemp: parseFloat(flowTempInput?.value)
    };
  }

  function setStatus(message) {
    if (outEl) outEl.textContent = message;
  }

  function setSolvedOutput(solvedJsonText) {
    if (outEl) outEl.textContent = solvedJsonText;

    if (!dlEl) return;

    if (lastDownloadUrl) {
      URL.revokeObjectURL(lastDownloadUrl);
      lastDownloadUrl = null;
    }

    const blob = new Blob([solvedJsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    lastDownloadUrl = url;

    dlEl.href = url;
    dlEl.style.pointerEvents = 'auto';
    dlEl.style.opacity = '1';
  }

  return {
    getTemperatureInputs,
    setStatus,
    setSolvedOutput
  };
}
