import { useParams, useNavigate } from 'react-router-dom';
import { useDemo } from '../store';
import { Button, Empty, Header } from '../components';
export function useDraft() {
  const { draftId } = useParams();
  const store = useDemo();
  return { ...store, draft: store.data.drafts.find((d) => d.id === draftId) };
}
export function MissingDraft() {
  const navigate = useNavigate();
  return (
    <>
      <Header title="Vägning saknas" />
      <main className="page-body">
        <Empty
          title="Utkastet finns inte kvar"
          text="Det kan ha tagits bort eller återställts på den här enheten."
          action={
            <Button onClick={() => navigate('/')}>Till startsidan</Button>
          }
        />
      </main>
    </>
  );
}
