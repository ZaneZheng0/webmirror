export interface ValidationResult {
  status: 'complete' | 'partial' | 'failed';
  errors: string[];
  warnings: string[];
}
