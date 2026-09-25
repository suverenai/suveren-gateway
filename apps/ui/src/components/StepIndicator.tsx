import { useNavigate } from 'react-router-dom';

const STEP_LABELS = ['Scope & Limits', 'Intent', 'Sign'];

interface Props {
  currentStep: number; // 2-4: scope+limits, intent, authorize
  onStepClick?: (step: number) => void;
}

/**
 * Wizard progress: equal-width columns, circle + label centred in each,
 * connector drawn as a pseudo-element at circle-centre height and stopping
 * short of the circle rings (see .wizard-step::before). The previous
 * inline-flex version centred the connector on circle+label and hung it off
 * the label's edge, so it sat too low and ran into the current step's ring.
 */
export function StepIndicator({ currentStep, onStepClick }: Props) {
  const navigate = useNavigate();

  return (
    <div className="wizard-progress">
      <ol className="wizard-steps">
        {STEP_LABELS.map((label, i) => {
          const step = i + 2;
          const isCompleted = step < currentStep;
          const isCurrent = step === currentStep;
          // The connector into this step is "done" once the previous step is.
          const reached = step - 1 < currentStep;
          const clickable = isCompleted && !!onStepClick;
          return (
            <li
              key={step}
              className={`wizard-step${reached ? ' reached' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <button
                type="button"
                className={`step-circle${isCompleted ? ' completed' : ''}${isCurrent ? ' current' : ''}`}
                onClick={clickable ? () => onStepClick(step) : undefined}
                disabled={!clickable}
                aria-label={`${label}${isCompleted ? ' (done)' : isCurrent ? ' (current)' : ''}`}
              >
                {isCompleted ? '✓' : i + 1}
              </button>
              <span className={`step-label-text${isCurrent ? ' current' : isCompleted ? ' completed' : ''}`}>
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="btn btn-ghost btn-sm wizard-cancel"
        onClick={() => navigate('/mandates?new=1')}
      >
        Cancel
      </button>
    </div>
  );
}
