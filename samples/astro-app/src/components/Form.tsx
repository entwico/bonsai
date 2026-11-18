import { Form } from '@samples/form-kit';
import { useFormContext } from 'react-hook-form';

function NameField() {
  const { register } = useFormContext<{ name: string }>();

  return <input {...register('name')} />;
}

// provider from @samples/form-kit (kept external), consumer hook from the app's
// own react-hook-form import. both must share one react-hook-form instance —
// otherwise useFormContext() returns null and rendering throws.
export function DemoForm() {
  return (
    <Form defaultValues={{ name: 'bonsai' }}>
      <NameField />
    </Form>
  );
}
